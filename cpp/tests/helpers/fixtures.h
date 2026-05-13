#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace mcp_cad {
namespace test {

inline std::filesystem::path fixtureDir() {
  return std::filesystem::path(__FILE__).parent_path().parent_path() / "fixtures";
}

inline std::string getFixturePath(const std::string& name) {
  return (fixtureDir() / name).string();
}

inline std::string getInf03FixturePath() {
  return getFixturePath("sheet_3panel.stp");
}

inline std::vector<std::string> getTier1Fixtures() {
  return {
      getFixturePath("simple_box.stp"),
      getFixturePath("sheet_1panel.stp"),
      getFixturePath("sheet_2panel.stp"),
      getFixturePath("sheet_3panel.stp"),
      getFixturePath("sheet_bracket.stp"),
  };
}

inline std::vector<std::string> getTier2Fixtures() {
  return {
      getFixturePath("sheet_compound_1.stp"),
      getFixturePath("sheet_compound_2.stp"),
      getFixturePath("sheet_hem_1.stp"),
      getFixturePath("sheet_cutout_1.stp"),
      getFixturePath("sheet_multi_bend_1.stp"),
  };
}

}  // namespace test
}  // namespace mcp_cad
