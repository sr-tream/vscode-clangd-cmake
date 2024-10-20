import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

import { ClangdConfig } from '../clangd_config_parser';
import { CompileCommands } from '../compile_commands';

suite('Test clangd config parser', () => {
	const configFilePath = path.join(__dirname, '..', '..', 'testdata', 'config.yaml');

	try {
		const config = new ClangdConfig(configFilePath);

		test('Inline files', () => {
			assert.strictEqual(config.getCompilationDatabase('src/file.inl'), '/database/for/inlines');
			assert.strictEqual(config.getCompilationDatabase('src/file.inc'), '/database/for/inlines');
		});

		test('Header files', () => {
			assert.strictEqual(config.getCompilationDatabase('include/file.h'), '/database/for/headers');
			assert.strictEqual(config.getCompilationDatabase('include/file.hh'), '/database/for/headers');
			assert.strictEqual(config.getCompilationDatabase('include/file.hpp'), '/database/for/headers');
			assert.strictEqual(config.getCompilationDatabase('include/file.hxx'), '/database/for/headers');
		});

		test('Precompiled header file', () => {
			assert.strictEqual(config.getCompilationDatabase('include/pch.h'), '/database/for/sources');
		});

		test('Source files', () => {
			assert.strictEqual(config.getCompilationDatabase('main.cpp'), '/database/for/sources');
		});
	} catch (err) {
		assert.fail(`Error: ${err}`);
	}
});

suite('Test clangd compile commands finder', () => {
	const projectsPath = path.join(__dirname, '..', '..', 'testdata', 'proj');

	test('compile_commands.json in project root directory', () => {
		const projectPath = path.join(projectsPath, 'inroot');
		const compileCommandsPath = path.join(projectPath, 'compile_commands.json');
		const finder = new CompileCommands(vscode.Uri.file(projectPath));

		assert.strictEqual(finder.findCompileCommands('main.cpp'), compileCommandsPath);
	});

	test('compile_commands.json in build directory', () => {
		const projectPath = path.join(projectsPath, 'inbuild');
		const compileCommandsPath = path.join(projectPath, 'build', 'compile_commands.json');
		const finder = new CompileCommands(vscode.Uri.file(projectPath));

		assert.strictEqual(finder.findCompileCommands('main.cpp'), compileCommandsPath);
	});

	test('compile_commands.json in project root and build directory', () => {
		const projectPath = path.join(projectsPath, 'inboth');
		const compileCommandsPath = path.join(projectPath, 'compile_commands.json');
		const finder = new CompileCommands(vscode.Uri.file(projectPath));

		assert.strictEqual(finder.findCompileCommands('main.cpp'), compileCommandsPath);
	});

	test('compile_commands.json in parent directory', () => {
		const projectPath = path.join(projectsPath, 'ancestors', 'src');
		const compileCommandsPath = path.normalize(path.join(projectPath, '..', 'build', 'compile_commands.json'));
		const finder = new CompileCommands(vscode.Uri.file(projectPath));

		assert.strictEqual(finder.findCompileCommands('main.cpp'), compileCommandsPath);
	});

	test('compile_commands.json must be unused', () => {
		const projectPath = path.join(projectsPath, 'none');
		const finder = new CompileCommands(vscode.Uri.file(projectPath));

		assert.strictEqual(finder.findCompileCommands('main.cpp'), undefined);
	});

	test('compile_commands.json in custom directory', () => {
		const projectPath = path.join(projectsPath, 'custom');
		const compileCommandsPath = path.join(projectPath, 'custom', 'build', 'directory', 'compile_commands.json');
		const finder = new CompileCommands(vscode.Uri.file(projectPath));

		assert.strictEqual(finder.findCompileCommands('main.cpp'), compileCommandsPath);
	});
});
