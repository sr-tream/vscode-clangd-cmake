# CMake Tools Integration for clangd

Basic integration of the [cmake-tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension for [clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd).

This extension passes the code model to clangd, but **set resource directory are experimental**. Therefore, this integration serves as an alternative way to export `compile_commands.json` when you are using CMake.

![settings](settings.png)





**This integration required clangd with merged PR [#575](https://github.com/clangd/vscode-clangd/pull/575)** (clangd 0.1.29 or newer)

## Example of usage

### Basic usage with `compile_commands.json` files in `build/`

For this, clangd should automatically detect the `compile_commands.json` files in `build/compile_commands.json`.

But for better cross-compilation support and/or enable clangd indexing, you can use these settings:

```json
"C_Cpp.intelliSenseEngine": "disabled",
"clangd.arguments": [
    "--query-driver=**/*gcc*,**/*g++*",
]
```

- `C_Cpp.intelliSenseEngine": "disabled"`: disable C/C++ IntelliSense engine as the source parsing is handled by clangd instead.
  C/C++ extensions can still be used for other things like debugging.
- `--query-driver=**/*gcc*,**/*g++*`: allow clangd to call any gcc/g++ based compiler to retrieve more information (like headers location when cross compiling).


## Usage using only the CMake codemodel (without `compile_commands.json` files)

This setup allow using non standard CMake build directory location without needing a per-project clangd configuration.

In your settings, configure clangd extension like this:

```json
"C_Cpp.intelliSenseEngine": "disabled",
"clangd.arguments": [
    "--compile_args_from=lsp",
    "--query-driver=**/*gcc*,**/*g++*",
]
```

- `--compile_args_from=lsp`: Provide the compilation database via LSP protocol without using a `compile_commands.json` file.
  This allows clangd parsing of projects with non-standard location for the `compile_commands.json` file (or when it is not generated).
- `--query-driver=**/*gcc*,**/*g++*`: see above chapter.
