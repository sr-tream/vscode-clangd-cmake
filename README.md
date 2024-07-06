# CMake Tools Integration for clangd

Basic integration of the [cmake-tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension for [clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd).

This extension passes the code model to clangd, but **set resource directory are experimental\***. Therefore, this integration serves as an alternative way to export `compile_commands.json` when you are using CMake.

\* Currently clangd restarting corrupt language client exported via API. Workaround - build [vscode-clangd](https://github.com/clangd/vscode-clangd) with PR [#649](https://github.com/clangd/vscode-clangd/pull/649)

![settings](settings.png)





**This integration required clangd with merged PR [#575](https://github.com/clangd/vscode-clangd/pull/575)** (clangd 0.1.29 or newer)

