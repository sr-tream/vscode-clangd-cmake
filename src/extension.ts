import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as vscodelc from 'vscode-languageclient/node';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

import * as api from 'vscode-cmake-tools';
import type { ClangdApiV1, ClangdExtension } from '@clangd/vscode-clangd';
import { CompileCommands } from './compile_commands';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;
const CLANGD_WAIT_TIME_MS = 200;

let WAIT_TO_CHECK_WRITING = 10;

let integrationInstance: CMakeToolsIntegration | undefined;

export async function activate(context: vscode.ExtensionContext) {
	const hash = crypto.createHash('md5').update(context.extension.id).digest('hex');
	WAIT_TO_CHECK_WRITING = (parseInt(hash, 16) % 1000) + 10;

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
	private compileArgsFrom: CompileArgsSource = CompileArgsSource.both;
	private restartingRequests: number = 0;
	private restartingReady: number = 0;
	private compileCommands: CompileCommands | undefined;
	private parsedCompileCommands = new Set<string>();
	private filesInCompileCommands = new Set<string>();

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
		this.codeModelChange?.dispose();
		this.projectChange.dispose();
		this.configChange.dispose();
		this.compileCommands?.dispose();
		this.parsedCompileCommands.clear();
		this.filesInCompileCommands.clear();
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
		if (this.compileCommands !== undefined) {
			this.compileCommands.dispose();
			this.compileCommands = undefined;
		}
		this.parsedCompileCommands.clear();
		this.filesInCompileCommands.clear();

		if (path === undefined)
			return;

		this.compileCommands = new CompileCommands(path);

		this.cmakeTools?.getProject(path).then(project => {
			this.project = project;
			this.codeModelChange =
				this.project?.onCodeModelChanged(this.onCodeModelChanged, this);
			this.onCodeModelChanged();
		});
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
				// Wait until configurations updated to restart clangd
				if (This.restartingRequests !== This.restartingReady) return;

				const lc = (await This.getClangd()).languageClient;

				// Language server not yet started, don't stop the timer and retry later
				if (lc.state != vscodelc.State.Running) {
					This.restartingRequests = 0;
					This.restartingReady = 0;
					return;
				}

				// Restart clangd if needed
				if (This.restartingReady > 0) {
					await vscode.commands.executeCommand('clangd.restart');
					This.restartingRequests = 0;
					This.restartingReady = 0;
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

				clearInterval(interval);
				resolve();
			}, CLANGD_WAIT_TIME_MS, this);
		});
	}

	async updateResourceDir(path?: string): Promise<void> {
		if (path === undefined) path = '';

		if (path === this.clangResourceDir) return;
		this.clangResourceDir = path;

		let config = vscode.workspace.getConfiguration('clangd');
		let args = config.get<string[]>('arguments', []);

		let curResourceDirArgIndex = args.findIndex(arg => arg.trimStart().startsWith("--resource-dir="));
		if (curResourceDirArgIndex >= 0) {
			let curResourceDir = args[curResourceDirArgIndex].trimStart().substring("--resource-dir=".length).trim();
			if (curResourceDir === path) return;

			if (path === '')
				args.splice(curResourceDirArgIndex, 1);
			else
				args[curResourceDirArgIndex] = "--resource-dir=" + path;
		} else {
			if (path === '') return;
			args.push("--resource-dir=" + path);
		}

		this.restartingRequests++;
		await config.update('arguments', args, vscode.ConfigurationTarget.Workspace);
		await CMakeToolsIntegration.sleep(WAIT_TO_CHECK_WRITING);
		if (!CMakeToolsIntegration.isEqual(args, vscode.workspace.getConfiguration("clangd").get<string[]>('arguments', []))) {
			path = this.clangResourceDir;
			this.clangResourceDir = '';
			await this.updateResourceDir(path);
			this.restartingRequests--;
			return;
		}

		this.restartingReady++;
	}

	private static isEqual(lhs: string[], rhs: string[]): boolean {
		if (lhs.length !== rhs.length)
			return false;

		for (const arg of lhs) {
			if (rhs.indexOf(arg) === -1)
				return false;
		}
		return true;
	}

	private static async sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private isFilePresentInCompileCommands(filePath: string): boolean {
		if (this.filesInCompileCommands.has(filePath))
			return true;

		if (this.compileCommands === undefined)
			return false;

		const compileCommandsPath = this.compileCommands.findCompileCommands(filePath);
		if (compileCommandsPath === undefined)
			return false;

		if (!this.parsedCompileCommands.has(compileCommandsPath)) {
			try {
				const compileCommandsContent = fs.readFileSync(compileCommandsPath).toString();
				const compileCommands = JSON.parse(compileCommandsContent);
				for (const command of compileCommands) {
					if (command.file !== undefined)
						this.filesInCompileCommands.add(command.file);
				}
			} catch (error) {
				// Ignore error
			}
			this.parsedCompileCommands.add(compileCommandsPath);
		}

		return this.filesInCompileCommands.has(filePath);
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

			let config = vscode.workspace.getConfiguration('clangd');
			const clangdFromToolchain = config.get<boolean>('useBinaryFromToolchain', false);
			if (clangdFromToolchain) {
				const binPath = firstCompiler.path.substring(0, firstCompiler.path.lastIndexOf(path.sep));
				const clangdPath = path.join(binPath, 'clangd');

				const exePath = config.get<string>('path');
				const fbPath = config.get<string>('pathFallback', '');

				if (fs.existsSync(clangdPath)) {
					if (fbPath == '') {
						const path = config.inspect<string>('path');
						if (path?.globalValue !== undefined)
							config.update('pathFallback', path.globalValue, vscode.ConfigurationTarget.Workspace);
						else if (path?.defaultValue !== undefined)
							config.update('pathFallback', path.defaultValue, vscode.ConfigurationTarget.Workspace);
					}

					if (clangdPath !== exePath) {
						this.restartingRequests++;
						config.update('path', clangdPath, vscode.ConfigurationTarget.Workspace).then(() => this.restartingReady++);
					}
				} else if (fbPath !== '' && fbPath !== exePath) {
					this.restartingRequests++;
					config.update('path', fbPath, vscode.ConfigurationTarget.Workspace).then(() => this.restartingReady++);
				}
			}

			const passForClangToolchains = config.get<boolean>('resourceDir.passForClangToolchains', false);
			const passForGccToolchains = config.get<boolean>('resourceDir.passForGccToolchains', false);
			let args: string | undefined;
			if (passForClangToolchains && compilerName.indexOf('clang') !== -1)
				args = "-print-file-name=";
			else if (passForGccToolchains && (compilerName.indexOf('gcc') !== -1 || compilerName.indexOf('g++') !== -1))
				args = "-print-file-name=";
			else if (passForClangToolchains && compilerName.indexOf('zig') !== -1)
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
								command => {
									if (!commandLine.includes(command)) {
										commandLine.push(command);
									}
								});
						});
						fileGroup.includePath?.forEach(
							include => { commandLine.push(`${incFlag}${include.path}`); });
						fileGroup.defines?.forEach(
							define => { commandLine.push(`${defFlag}${define}`); });
						fileGroup.sources.forEach(source => {
							const file = sourceDirectory.length != 0
								? sourceDirectory + path.sep + source
								: source;
							if (this.compileArgsFrom !== CompileArgsSource.lsp && this.isFilePresentInCompileCommands(file))
								return;

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
