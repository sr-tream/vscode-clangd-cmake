# Changelog

## 0.2.1

- Recognize macOS Apple Clang when CMake reports `cc` or `c++`, and query its resource directory with `-print-resource-dir`.
- Remove stale resource-directory overrides on startup even when no compiler resource directory is selected.
- Query compilers without a shell so toolchain paths containing spaces work, and reject missing or invalid resource directories.
