# MCP CAD System

## Feature Summary
The MCP CAD System provides "Apply Architecture and Engineering Designs to Specification." It processes STEP files for sheet metal production, including feature extraction, gap analysis, unfolding, layout synthesis, and automated manufacturability scoring for CNC/laser cutting. It integrates via the Model Context Protocol (MCP).

## Build Instructions
1. We use a multi-stage Dockerfile:
   ```bash
   docker build -t mcp-cad-server -f cpp/Dockerfile .
   ```
2. Run the server:
   ```bash
   docker run -p 8080:8080 mcp-cad-server
   ```
   *(Or use `docker-compose up`)*

For detailed local setup, see [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## MVP Acceptance Criteria
- **Architecture**: Bounded contexts (Geometry Engine in C++, Manufacturing Domain in TypeScript, etc.) properly separated.
- **Functionality**: Full end-to-end extraction, decomposition, and nesting works on canonical test fixtures. Export to DXF files with Job ID queuing passes.
- **Reliability**: Geometry Engine contains zero memory leaks mapped via AddressSanitizer. Wait-free fallback on asynchronous CAD endpoints behaves reliably.
- **Coverage**: Total Test Code Coverage > 85%.

See [docs/MVP_ACCEPTANCE.md](docs/MVP_ACCEPTANCE.md) for full gate criteria status.
