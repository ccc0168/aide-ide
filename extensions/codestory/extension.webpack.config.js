/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const withDefaults = require('../shared.webpack.config');

module.exports = withDefaults({
	context: __dirname,
	resolve: {
		fallback: {
			'request': require.resolve('node-fetch')
		}
	},
	entry: {
		extension: './src/extension.ts'
	}
});
