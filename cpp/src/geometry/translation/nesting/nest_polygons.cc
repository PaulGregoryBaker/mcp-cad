#include "geometry/translation/nesting/nest_polygons.hpp"

#include <libnest2d/libnest2d.hpp>

#include <algorithm>
#include <cmath>
#include <utility>

namespace mcp_cad::translation {

namespace {

constexpr double kCoordScale = 1e6;  // Clipper backend MM_IN_COORDS
constexpr double kPi = 3.14159265358979323846;

ClipperLib::cInt toInt(double mm) {
  return static_cast<ClipperLib::cInt>(std::llround(mm * kCoordScale));
}

double toDouble(ClipperLib::cInt v) {
  return static_cast<double>(v) / kCoordScale;
}

// Twice the signed area: >0 CCW, <0 CW (shoelace).
double signedArea2(const std::vector<Point2>& ring) {
  double s = 0.0;
  const size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& p = ring[i];
    const Point2& q = ring[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return s;
}

double ringAreaMm2(const std::vector<Point2>& ring) {
  return std::fabs(signedArea2(ring)) / 2.0;
}

double partAreaMm2(const NestPolygonInput& in) {
  double a = ringAreaMm2(in.outer);
  for (const auto& h : in.holes) a -= ringAreaMm2(h);
  return a;
}

void normalizeCcw(std::vector<Point2>& ring) {
  if (signedArea2(ring) < 0.0) std::reverse(ring.begin(), ring.end());
}

void normalizeCw(std::vector<Point2>& ring) {
  if (signedArea2(ring) > 0.0) std::reverse(ring.begin(), ring.end());
}

// Clipper paths are closed (first vertex repeated at the end); our Point2
// outlines are open CCW rings (holes CW). libnest2d's Clipper backend stores
// outer contours CLOCKWISE — its offset() (used for item inflation) reverses
// orientation and re-classifies CCW results as outer / CW as holes — so we
// reverse outer CCW -> CW here. The NFP glue re-normalises as its solver
// requires; fromClipperPath/normalize* restore v2's CCW/CW convention on the
// way out.
ClipperLib::Path toClipperPath(const std::vector<Point2>& ring) {
  ClipperLib::Path p;
  p.reserve(ring.size() + 1);
  for (const Point2& pt : ring) p.emplace_back(toInt(pt.x), toInt(pt.y));
  std::reverse(p.begin(), p.end());
  if (!p.empty() && p.front() != p.back()) p.push_back(p.front());
  return p;
}

std::vector<Point2> fromClipperPath(const ClipperLib::Path& p, bool dropClosing) {
  std::vector<Point2> out;
  size_t n = p.size();
  if (dropClosing && n > 1 && p.front() == p.back()) --n;
  out.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    out.push_back({toDouble(p[i].X), toDouble(p[i].Y)});
  }
  return out;
}

NestPolygonResult makeError(NestErrorCode code, std::string message) {
  NestPolygonResult r;
  r.ok = false;
  r.errorCode = code;
  r.message = std::move(message);
  return r;
}

}  // namespace

NestErrorCode NestErrorCodeFromString(const std::string& s) {
  if (s == "NEST_INVALID_INPUT") return NestErrorCode::kInvalidInput;
  if (s == "NEST_INVALID_CUTTING_WIDTH") return NestErrorCode::kInvalidCuttingWidth;
  if (s == "NEST_PART_EXCEEDS_SHEET") return NestErrorCode::kPartExceedsSheet;
  return NestErrorCode::kNone;
}

std::string NestErrorCodeToString(NestErrorCode code) {
  switch (code) {
    case NestErrorCode::kInvalidInput: return "NEST_INVALID_INPUT";
    case NestErrorCode::kInvalidCuttingWidth: return "NEST_INVALID_CUTTING_WIDTH";
    case NestErrorCode::kPartExceedsSheet: return "NEST_PART_EXCEEDS_SHEET";
    case NestErrorCode::kNone: return "";
  }
  return "";
}

NestPolygonResult nestPolygons(
    const std::vector<NestPolygonInput>& parts,
    double sheetWidthMm,
    double sheetHeightMm,
    const NestPolygonOptions& opts) {

  if (parts.empty()) {
    return makeError(NestErrorCode::kInvalidInput,
                     "nestPolygons requires at least one part");
  }
  if (sheetWidthMm <= 0 || sheetHeightMm <= 0) {
    return makeError(NestErrorCode::kInvalidInput,
                     "sheet dimensions must be positive");
  }
  if (opts.cuttingWidthMm <= 0 || opts.cuttingWidthMm > opts.maxKerfWidthMm) {
    return makeError(NestErrorCode::kInvalidCuttingWidth,
                     "cutting width must be > 0 and <= max kerf width");
  }
  if (opts.rotationsDeg.empty()) {
    return makeError(NestErrorCode::kInvalidInput,
                     "at least one allowed rotation is required");
  }
  if (opts.copies == 0) {
    return makeError(NestErrorCode::kInvalidInput,
                     "copies must be -1 (fill) or >= 1");
  }

  // ── Geometry cache: one PolygonImpl + area per distinct part ──────────────
  struct Geom {
    std::string id;
    libnest2d::PolygonImpl poly;
    std::vector<NestCircleHole> polyCircleHoles;
    double areaMm2 = 0.0;
  };
  std::vector<Geom> geoms;
  geoms.reserve(parts.size());
  for (const auto& in : parts) {
    if (in.outer.size() < 3) {
      return makeError(NestErrorCode::kInvalidInput,
                       "part '" + in.id + "' outline has fewer than 3 vertices");
    }
    const double area = partAreaMm2(in);
    if (area <= 0.0) {
      return makeError(NestErrorCode::kInvalidInput,
                       "part '" + in.id + "' has zero or negative area");
    }
    Geom g;
    g.id = in.id;
    g.poly.Contour = toClipperPath(in.outer);
    for (const auto& h : in.holes) g.poly.Holes.push_back(toClipperPath(h));
    g.polyCircleHoles = in.circleHoles;
    g.areaMm2 = area;
    geoms.emplace_back(std::move(g));
  }

  // ── Solver configuration ──────────────────────────────────────────────────
  // BottomLeftPlacer: gravity-based placement using the Clipper backend's own
  // boolean intersection tests — no no-fit-polygon, so it is robust for
  // concave/irregular outlines (rebuild/21-nesting-libnest2d.md §1).
  libnest2d::NestConfig<libnest2d::BottomLeftPlacer, libnest2d::FirstFitSelection> cfg;
  cfg.placer_config.allow_rotations = !opts.rotationsDeg.empty();

  const ClipperLib::cInt margin = toInt(opts.sheetMarginMm);
  const ClipperLib::cInt W = toInt(sheetWidthMm);
  const ClipperLib::cInt H = toInt(sheetHeightMm);
  // Origin-based bin: the sheet margin is baked in by shrinking the bin, so
  // BottomLeftPlacer's (0,0)-anchored placement reports sheet-frame coords.
  const libnest2d::Box bin({0, 0}, {W - margin, H - margin});
  const libnest2d::Coord dist = toInt(opts.cuttingWidthMm + opts.safetyGapMm);

  // ── Item assembly: `kits` complete kits (one copy of each part, in order) ──
  auto buildItems = [&geoms](int kits) {
    std::vector<libnest2d::Item> items;
    std::vector<std::pair<int, int>> map;  // geom index, copy index
    items.reserve(static_cast<size_t>(kits) * geoms.size());
    map.reserve(static_cast<size_t>(kits) * geoms.size());
    for (int k = 0; k < kits; ++k) {
      for (size_t g = 0; g < geoms.size(); ++g) {
        items.emplace_back(geoms[g].poly);
        map.emplace_back(static_cast<int>(g), k);
      }
    }
    return std::make_pair(std::move(items), std::move(map));
  };

  auto runNest = [&](std::vector<libnest2d::Item>& items) {
    const size_t bins =
        libnest2d::nest<libnest2d::BottomLeftPlacer, libnest2d::FirstFitSelection>(
            items.begin(), items.end(), bin, dist, cfg);
    std::vector<size_t> unplaced;
    for (size_t i = 0; i < items.size(); ++i) {
      if (items[i].binId() == libnest2d::BIN_ID_UNSET) unplaced.push_back(i);
    }
    return std::make_pair(bins, std::move(unplaced));
  };

  // BottomLeftPlacer is a heuristic: its gravity descent relies on a
  // left/down "wall polygon" scan that does NOT detect all concave-shape
  // collisions. It reports success even when two placed items overlap. We
  // therefore validate the real constraint (zero pairwise overlap area on
  // each sheet) with Clipper booleans. Touching at a point/edge yields zero
  // intersection area and is allowed.
  auto polygonsOverlap = [](const libnest2d::PolygonImpl& a,
                            const libnest2d::PolygonImpl& b) {
    ClipperLib::Clipper cl;
    cl.Clear();
    cl.AddPath(a.Contour, ClipperLib::ptSubject, true);
    for (const auto& h : a.Holes) cl.AddPath(h, ClipperLib::ptSubject, true);
    cl.AddPath(b.Contour, ClipperLib::ptClip, true);
    for (const auto& h : b.Holes) cl.AddPath(h, ClipperLib::ptClip, true);
    ClipperLib::Paths out;
    if (!cl.Execute(ClipperLib::ctIntersection, out, ClipperLib::pftNonZero,
                    ClipperLib::pftNonZero)) {
      return true;  // boolean failure: do not silently accept the placement
    }
    for (const auto& p : out) {
      if (std::llabs(ClipperLib::Area(p)) > 0) return true;
    }
    return false;
  };

  auto findOverlapping = [&](const std::vector<libnest2d::Item>& items) {
    std::vector<size_t> overlap;
    for (size_t i = 0; i < items.size(); ++i) {
      if (items[i].binId() == libnest2d::BIN_ID_UNSET) continue;
      for (size_t j = 0; j < i; ++j) {
        if (items[j].binId() != items[i].binId()) continue;
        if (polygonsOverlap(items[i].transformedShape(),
                            items[j].transformedShape())) {
          overlap.push_back(i);
          break;
        }
      }
    }
    return overlap;
  };

  std::vector<libnest2d::Item> placedItems;
  std::vector<std::pair<int, int>> placedMap;
  size_t sheetsRequired = 0;

  auto oversizeError = [&](const std::vector<size_t>& unplaced,
                           const std::vector<std::pair<int, int>>& map) {
    const auto& in = parts[static_cast<size_t>(map[unplaced.front()].first)];
    return makeError(NestErrorCode::kPartExceedsSheet,
                     "part '" + in.id + "' does not fit on a single " +
                         std::to_string(static_cast<int>(sheetWidthMm)) + "x" +
                         std::to_string(static_cast<int>(sheetHeightMm)) + " sheet");
  };

  if (opts.copies == -1) {
    // Fill mode: pack complete kits onto the ONE given sheet until the next
    // full kit no longer fits — i.e. the nest spills to a second sheet (or a
    // placement overlaps). The sheet is bounded: fill does NOT grow to extra
    // sheets (rebuild/21-nesting-libnest2d.md §5.1, §11: "one more copy
    // cannot fit").
    constexpr int kMaxKits = 10000;  // safety cap only; the loop exits on spill
    int kits = 1;
    while (kits <= kMaxKits) {
      auto [items, map] = buildItems(kits);
      auto [bins, unplaced] = runNest(items);
      const bool fits = unplaced.empty() && bins <= 1 &&
                        findOverlapping(items).empty();
      if (!fits) {
        if (kits == 1) {
          if (!unplaced.empty()) return oversizeError(unplaced, map);
          if (bins > 1) {
            const size_t idx = static_cast<size_t>(map.front().first);
            return makeError(
                NestErrorCode::kPartExceedsSheet,
                "part '" + parts[idx].id + "' does not fit on a single " +
                    std::to_string(static_cast<int>(sheetWidthMm)) + "x" +
                    std::to_string(static_cast<int>(sheetHeightMm)) + " sheet");
          }
          return makeError(NestErrorCode::kInvalidInput,
                           "a single kit overlaps during placement");
        }
        break;  // previous (kits-1) run is the last fully-packed result
      }
      placedItems = std::move(items);
      placedMap = std::move(map);
      sheetsRequired = bins;
      ++kits;
    }
  } else {
    auto [items, map] = buildItems(opts.copies);
    auto [bins, unplaced] = runNest(items);
    if (!unplaced.empty()) return oversizeError(unplaced, map);
    if (!findOverlapping(items).empty()) {
      return makeError(NestErrorCode::kInvalidInput,
                       "placements overlap on a sheet");
    }
    placedItems = std::move(items);
    placedMap = std::move(map);
    sheetsRequired = bins;
  }

  // ── Assemble result ───────────────────────────────────────────────────────
  NestPolygonResult result;
  result.ok = true;
  result.errorCode = NestErrorCode::kNone;
  result.sheetsRequired = static_cast<int>(sheetsRequired);

  double placedAreaMm2 = 0.0;
  for (size_t i = 0; i < placedItems.size(); ++i) {
    const auto& item = placedItems[i];
    if (item.binId() == libnest2d::BIN_ID_UNSET) continue;

    const Geom& g = geoms[static_cast<size_t>(placedMap[i].first)];
    placedAreaMm2 += g.areaMm2;

    NestPolygonPlacement pl;
    pl.id = g.id;
    pl.copyIndex = placedMap[i].second;
    pl.sheetIndex = item.binId();
    const auto tr = item.translation();
    pl.x = toDouble(tr.X);
    pl.y = toDouble(tr.Y);
    pl.rotationDeg = item.rotation().toDegrees();

    const auto& tsh = item.transformedShape();
    pl.outline = fromClipperPath(tsh.Contour, /*dropClosing=*/true);
    normalizeCcw(pl.outline);
    for (const auto& h : tsh.Holes) {
      auto hole = fromClipperPath(h, /*dropClosing=*/true);
      normalizeCw(hole);
      pl.holes.emplace_back(std::move(hole));
    }

    // Exact circle holes: rotate the centre by the applied rotation, then add
    // the applied translation. A circle is rotation-invariant, so only the
    // centre moves — never tessellated.
    const double rad = pl.rotationDeg * kPi / 180.0;
    const double ca = std::cos(rad);
    const double sa = std::sin(rad);
    for (const auto& ch : g.polyCircleHoles) {
      NestCircleHole out;
      out.cx = ca * ch.cx - sa * ch.cy + pl.x;
      out.cy = sa * ch.cx + ca * ch.cy + pl.y;
      out.radiusMm = ch.radiusMm;
      pl.circleHoles.emplace_back(out);
    }
    result.placements.emplace_back(std::move(pl));
  }

  const double sheetAreaMm2 = sheetWidthMm * sheetHeightMm;
  result.utilisationPct =
      result.sheetsRequired > 0
          ? std::min(100.0, 100.0 * placedAreaMm2 /
                                (static_cast<double>(result.sheetsRequired) * sheetAreaMm2))
          : 0.0;

  return result;
}

}  // namespace mcp_cad::translation
