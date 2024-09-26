import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

import * as api from 'vscode-cmake-tools';
import type { ClangdApiV1, ClangdExtension } from '@clangd/vscode-clangd';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;
const CLANGD_WAIT_TIME_MS = 200;

let integrationInstance: CMakeToolsIntegration | undefined;

export async function activate(context: vscode.ExtensionContext) {
	integrationInstance = new CMakeToolsIntegration();
}

export function deactivate() {
	if (integrationInstance) {
		integrationInstance.dispose();
	}
}

namespace protocol {
	interface DidChangeConfigurationClientCapabilities {
		dynamicRegistration?: boolean;
	}

	export interface ClangdCompileCommand {
		// Directory
		workingDirectory: string;
		// Command line
		compilationCommand: string[];
	}

	interface ConfigurationSettings {
		// File -> ClangdCompileCommand
		compilationDatabaseChanges: Object;
	}

	export interface DidChangeConfigurationParams {
		settings: ConfigurationSettings;
	}

	export namespace DidChangeConfigurationRequest {
		export const type = 'workspace/didChangeConfiguration';
	}
} // namespace protocol

enum CompileArgsSource {
	lsp = 'lsp',
	filesystem = 'filesystem',
	both = ''
};

class CMakeToolsIntegration implements vscode.Disposable {
	private projectChange: vscode.Disposable = { dispose() { } };
	private codeModelChange: vscode.Disposable | undefined;
	private configChange: vscode.Disposable = { dispose() { } };
	private cmakeTools: api.CMakeToolsApi | undefined;
	private project: api.Project | undefined;
	private codeModel: Map<string, protocol.ClangdCompileCommand> | undefined;
	private clangd: ClangdApiV1 | undefined;
	private clangResourceDir: string = '';
	private buildDirectory: string = '';
	private compileArgsFrom: CompileArgsSource = CompileArgsSource.both;
	private restarting = false;

	constructor() {
		let cmakeTools = api.getCMakeToolsApi(api.Version.v1);
		if (cmakeTools === undefined)
			return;

		this.monitorClangdRestarts();

		this.updateCompileArgsSource();
		this.configChange = vscode.workspace.onDidChangeConfiguration(this.onUpdateConfiguration, this);

		cmakeTools.then(api => {
			this.cmakeTools = api;
			if (this.cmakeTools === undefined)
				return;

			this.projectChange = this.cmakeTools.onActiveProjectChanged(
				this.onActiveProjectChanged, this);
			if (vscode.workspace.workspaceFolders !== undefined) {
				// FIXME: clangd not supported multi-workspace projects
				const projectUri = vscode.workspace.workspaceFolders[0].uri;
				this.onActiveProjectChanged(projectUri);
			}
		});
	}
	dispose() {
		if (this.codeModelChange !== undefined)
			this.codeModelChange.dispose();
		this.projectChange.dispose();
		this.configChange.dispose();
	}

	async getClangd() {
		if (this.clangd == undefined || this.clangd.languageClient.state === vscodelc.State.Stopped) {
			const clangdExtension = vscode.extensions.getExtension<ClangdExtension>(CLANGD_EXTENSION);
			if (!clangdExtension) {
				throw new Error('Could not find clangd extension');
			}
			this.clangd = clangdExtension.exports.getApi(CLANGD_API_VERSION);
		}

		return this.clangd;
	}

	async onActiveProjectChanged(path: vscode.Uri | undefined) {
		if (this.codeModelChange !== undefined) {
			this.codeModelChange.dispose();
			this.codeModelChange = undefined;
		}

		if (path === undefined)
			return;

		this.cmakeTools?.getProject(path).then(project => {
			this.project = project;
			this.project?.getBuildDirectory().then(buildDirectory => {
				this.buildDirectory = buildDirectory ? buildDirectory : path.fsPath;
				this.codeModelChange =
					this.project?.onCodeModelChanged(this.onCodeModelChanged, this);
				this.onCodeModelChanged();
			});
		});
	}

	public async doRestartClangd() {
		if (!this.restarting)
			return;

		vscode.commands.executeCommand('clangd.restart');
		// monitorClangdRestarts() will detect the restart and reconfigure the new clangd instance
		// using waitClangdStartedAndConfigure().
	}

	// Monitor when the language server is restarted, to re-send compilation database
	async monitorClangdRestarts() {
		const clangd = await this.getClangd();

		clangd.languageClient.onDidChangeState(async ({ newState }) => {
			if (newState === vscodelc.State.Stopped) {
				// Wait for the clangd server to be running again.
				await this.waitClangdStartedAndConfigure();

				// Monitor future restarts of this clangd instance.
				// This is not done in waitClangdStartedAndConfigure to avoid registering
				// duplicate event handlers with onDidChangeState().
				this.monitorClangdRestarts();
			}
		});
	}

	// Wait for clangd server to be started and resend configuration
	waitClangdStartedAndConfigure() {
		return new Promise<void>((resolve) => {
			const interval = setInterval(async function (This: CMakeToolsIntegration) {
				const lc = (await This.getClangd()).languageClient;

				// Language server not yet started, don't stop the timer and retry later
				if (lc.state != vscodelc.State.Running) {
					return;
				}

				// If we have a codeModel, send compilation database updates via LSP protocol
				if (This.codeModel !== undefined) {
					const request: protocol.DidChangeConfigurationParams = {
						settings: { compilationDatabaseChanges: {} }
					};

					This.codeModel.forEach(
						(cc, file) => {
							Object.assign(
								request.settings.compilationDatabaseChanges, { [file]: cc })
						});

					lc.sendNotification(
						protocol.DidChangeConfigurationRequest.type, request);
				}

				This.restarting = false;
				clearInterval(interval);
				resolve();
			}, CLANGD_WAIT_TIME_MS, this);
		});
	}

	async restartClangd() {
		if (this.restarting)
			return;

		this.restarting = true;
		setTimeout(function (This: CMakeToolsIntegration) {
			This.doRestartClangd();
		}, CLANGD_WAIT_TIME_MS * 10, this);
	}

	async updateResourceDir(path?: string) {
		if (path === undefined) path = '';

		if (path === this.clangResourceDir) return;
		this.clangResourceDir = path;

		let config = vscode.workspace.getConfiguration('clangd');
		if (!config.get<boolean>('resourceDir.passForClangToolchains', false))
			return;

		let args = config.get<string[]>('arguments', []);
		let curResourceDirArgIndex = args.findIndex(arg => arg.trimStart().startsWith("--resource-dir="));
		if (curResourceDirArgIndex >= 0) {
			let curResourceDir = args[curResourceDirArgIndex].trimStart().substring("--resource-dir=".length).trim();
			if (curResourceDir === path) return;
			args[curResourceDirArgIndex] = "--resource-dir=" + path;
		} else
			args.push("--resource-dir=" + path);

		config.update('arguments', args, vscode.ConfigurationTarget.Workspace).then(() => {
			this.restartClangd();
		});
	}

	async onCodeModelChanged() {
		const content = this.project?.codeModel;
		if (content === undefined)
			return;

		if (content.toolchains === undefined)
			return;

		const firstCompiler =
			content.toolchains.values().next().value as api.CodeModel.Toolchain ||
			undefined;
		if (firstCompiler !== undefined) {
			let compilerName =
				firstCompiler.path
					.substring(firstCompiler.path.lastIndexOf(path.sep) + 1)
					.toLowerCase();
			if (compilerName.endsWith('.exe'))
				compilerName = compilerName.substring(0, compilerName.length - 4);

			let args: string | undefined;
			if (compilerName.indexOf('clang') !== -1 || compilerName.indexOf('gcc') !== -1 || compilerName.indexOf('g++') !== -1)
				args = "-print-file-name=";
			else if (compilerName.indexOf('zig') !== -1)
				args = "c++ -print-file-name="; // Zig calling clang/clang++ for cc/c++ dropin replacement. clang and clang++ returns same path
			if (args !== undefined) {
				exec(`${firstCompiler.path} ${args}`,
					(error, stdout, stderr) => {
						if (error) {
							this.updateResourceDir();
							return;
						}
						while (stdout.endsWith('\n') || stdout.endsWith('\r'))
							stdout = stdout.slice(0, -1);
						this.updateResourceDir(stdout);
					});
			} else this.updateResourceDir();
		}

		if (this.compileArgsFrom === CompileArgsSource.filesystem) return;

		let compileCommandsFiles = new Set<string>();
		if (this.compileArgsFrom !== CompileArgsSource.lsp) {
			const compileCommandsPath = path.join(this.buildDirectory, 'compile_commands.json');
			if (fs.existsSync(compileCommandsPath)) {
				try {
					const compileCommandsContent = fs.readFileSync(compileCommandsPath).toString();
					const compileCommands = JSON.parse(compileCommandsContent);
					for (const command of compileCommands) {
						if (command.file !== undefined)
							compileCommandsFiles.add(command.file);
					}
				} catch (error) {
					// Ignore error
				}
			}
		}

		let codeModelChanges: Map<string, protocol.ClangdCompileCommand> =
			new Map();
		content.configurations.forEach(configuration => {
			configuration.projects.forEach(project => {
				let sourceDirectory = project.sourceDirectory;
				project.targets.forEach(target => {
					if (target.sourceDirectory !== undefined)
						sourceDirectory = target.sourceDirectory;
					let commandLine: string[] = [];
					if (target.sysroot !== undefined)
						commandLine.push(`--sysroot=${target.sysroot}`);
					target.fileGroups?.forEach(fileGroup => {
						if (fileGroup.language === undefined)
							return;

						const compiler = content.toolchains?.get(fileGroup.language);
						if (compiler === undefined)
							return;

						commandLine.unshift(compiler.path);
						if (compiler.target !== undefined)
							commandLine.push(`--target=${compiler.target}`);

						let compilerName =
							compiler.path.substring(compiler.path.lastIndexOf(path.sep) + 1)
								.toLowerCase();
						if (compilerName.endsWith('.exe'))
							compilerName = compilerName.substring(0, compilerName.length - 4);

						const ClangCLMode =
							compilerName === 'cl' || compilerName === 'clang-cl';
						const incFlag = ClangCLMode ? '/I' : '-I';
						const defFlag = ClangCLMode ? '/D' : '-D';

						fileGroup.compileCommandFragments?.forEach(commands => {
							commands.split(/\s/g).forEach(
								command => { commandLine.push(command); });
						});
						fileGroup.includePath?.forEach(
							include => { commandLine.push(`${incFlag}${include.path}`); });
						fileGroup.defines?.forEach(
							define => { commandLine.push(`${defFlag}${define}`); });
						fileGroup.sources.forEach(source => {
							const file = sourceDirectory.length != 0
								? sourceDirectory + path.sep + source
								: source;
							if (this.compileArgsFrom !== CompileArgsSource.lsp && compileCommandsFiles.has(file)) {
								compileCommandsFiles.delete(file);
								return;
							}
							const command: protocol.ClangdCompileCommand = {
								workingDirectory: sourceDirectory,
								compilationCommand: commandLine
							};
							codeModelChanges.set(file, command);
						});
					});
				});
			});
		});

		const codeModel = new Map(codeModelChanges);
		this.codeModel?.forEach((cc, file) => {
			if (!codeModelChanges.has(file)) {
				const command: protocol.ClangdCompileCommand = {
					workingDirectory: '',
					compilationCommand: []
				};
				codeModelChanges.set(file, command);
				return;
			}
			const command = codeModelChanges.get(file);
			if (command?.workingDirectory === cc.workingDirectory &&
				command?.compilationCommand.length === cc.compilationCommand.length &&
				command?.compilationCommand.every(
					(val, index) => val === cc.compilationCommand[index])) {
				codeModelChanges.delete(file);
			}
		});
		this.codeModel = codeModel;

		if (codeModelChanges.size === 0)
			return;

		this.waitClangdStartedAndConfigure();
	}

	private updateCompileArgsSource() {
		const config = vscode.workspace.getConfiguration('clangd');
		const args = config.get<string[]>('arguments', []);

		const compileArgsFromValue = args.find((value) => value.startsWith('--compile_args_from='));
		if (compileArgsFromValue === undefined) {
			this.compileArgsFrom = CompileArgsSource.both;
			return;
		}

		const value = compileArgsFromValue.split('=')[1];
		this.compileArgsFrom = value as CompileArgsSource;
	}

	private async onUpdateConfiguration(event: vscode.ConfigurationChangeEvent) {
		if (event.affectsConfiguration('clangd.arguments')) this.updateCompileArgsSource();
	}
}
