import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

import { ClangdConfig } from '../clangd_config_parser';

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
