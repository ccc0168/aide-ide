/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActiveFilesTracker } from '../activeChanges/activeFilesTracker';
import { getFilesTrackedInWorkingDirectory } from '../git/helper';
import { CodeSymbolsLanguageCollection } from '../languages/codeSymbolsLanguageCollection';
import { CodeSymbolInformation } from '../utilities/types';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// What do we need from the code graph:
// A way to visualize what the code symbol connections look like (we are talking
// in terms of code symbols and not code snippets here)
// 1. Lazy loading so if we want to get information about a file, we should be
// able to get the following quickly: references and the code symbols and the
// go to definitions (going 1 level and parsing the asked file is also fine)
// 2. force input: if the user has asked for a specific file, we should be able
// to get the information by force (run it again)
// 3. we need the complete graph for the change tracker: This is pretty expensive
// to create at runtime, but we can figure something out for this too, the reason
// is: code symbols are not just directly related A -> B, there might be A -> B -> C
// kind of relations and we would still want to group them together
//
// TODO(codestory):
// - figure out how to do fast loading, we will bias towards looking at git log for the git user
// and looking at the recent changes in the last 2 weeks, and one for all the commits in the last
// 2 weeks
// - we need to build the force load file option in the code graph so its primed up and ready
// - make it load completely for the whole code base (this can keep happening in the background)
// need to take care of the changes which come in at the same time we are building (making this a bit
// non-trivial)


export enum CodeGraphFileState {
	// Deep indexed is when we have the dependency and the references indexed
	// for the current file
	DeepIndexed,
	// Shallow indexed is when we have just the code symbols but not the dependencies
	// indexed (so dependencies are missing from the code symbols and we should
	// not rely on them)
	ShallowIndexed,
	// as the name says...
	NotIndexed,
}


export interface FileState {
	filePath: string;
	fileHash: string;
	codeGraphState: CodeGraphFileState;
}


// We also store the hash of the file, which is a representation of the file
// content at the time, this helps us figure out if the file content was changed
// and we need to re-index the file again
export interface CodeGraphCodeSymbolInformation {
	codeSymbol: CodeSymbolInformation;
	filePath: string;
	fileHash: string;
}


async function loadCodeSymbolDescriptionFromLocalStorage(
	storageLocation: string,
): Promise<CodeGraphCodeSymbolInformation[]> {
	let files: string[] = [];
	try {
		files = await fs.promises.readdir(storageLocation);
	} catch (err) {
		// We failed to read from the directory path, so lets bail hard here
		return [];
	}
	const codeSymbolInformationList: CodeGraphCodeSymbolInformation[] = [];
	for (let index = 0; index < files.length; index++) {
		const file = files[index];
		const filePath = path.join(storageLocation, file);
		try {
			const fileContent = await fs.promises.readFile(filePath);
			const codeGraphCodeSymbolInformation = JSON.parse(fileContent.toString()) as CodeGraphCodeSymbolInformation;
			codeSymbolInformationList.push(codeGraphCodeSymbolInformation);
		} catch (error) {
			// We missed loading a code symbol, that's fine for now, lets keep going
			// we should be logging this to posthog
			// TODO(codestory): log to posthog here
		}
	}
	return codeSymbolInformationList;
}


export class CodeGraph {
	private _fileToCodeSymbolMapped: Map<string, FileState>;
	private _activeFilesTracker: ActiveFilesTracker;
	private _nodes: CodeGraphCodeSymbolInformation[];
	private _storageLocation: string;
	private _repoName: string;

	constructor(
		activeFilesTracker: ActiveFilesTracker,
		storageLocation: string,
		repoName: string,
	) {
		this._nodes = [];
		this._fileToCodeSymbolMapped = new Map();
		this._activeFilesTracker = activeFilesTracker;
		this._storageLocation = storageLocation;
		this._repoName = repoName;
	}

	public addNodes(nodes: CodeGraphCodeSymbolInformation[]) {
		this._nodes.push(...nodes);
	}

	// Returns the list of files which need re-indexing
	async loadFromStorage(filesToTrack: string[]): Promise<string[]> {
		// We always try to load from the storage anyways, because it can be
		const storageLocation = path.join(
			this._storageLocation,
			this._repoName,
			'codeGraphSymbols',
		);
		const codeSymbolInformationList = await loadCodeSymbolDescriptionFromLocalStorage(
			storageLocation,
		);
		const crypto = await import('crypto');

		const fileToHashMap: Map<string, string> = new Map();
		const filesWhichNeedIndexing: Set<string> = new Set();
		for (let index = 0; index < filesToTrack.length; index++) {
			// get the file hash
			const fileContent = await fs.promises.readFile(filesToTrack[index], 'utf8');
			const fileContentHash = crypto.createHash('sha256').update(fileContent, 'utf8').digest('hex');
			fileToHashMap.set(filesToTrack[index], fileContentHash);
			filesWhichNeedIndexing.add(filesToTrack[index]);
		}

		// which nodes we have to evict, can be many reasons, like the file was
		// modified or deleted or moved etc
		const nodesToEvict: Set<string> = new Set();
		const filesToReIndex: Set<string> = new Set();
		for (let index = 0; index < codeSymbolInformationList.length; index++) {
			const codeSymbolInformation = codeSymbolInformationList[index];
			const currentFilePath = codeSymbolInformation.codeSymbol.fsFilePath;
			const currentFileHash = codeSymbolInformation.fileHash;
			if (fileToHashMap.has(currentFilePath)) {
				const fileHash = fileToHashMap.get(currentFilePath);
				if (fileHash === currentFileHash) {
					// All good, we keep this as is
					filesWhichNeedIndexing.delete(currentFilePath);
				} else {
					// The file hash has changed, we need to re-index this file
					filesToReIndex.add(currentFilePath);
					nodesToEvict.add(codeSymbolInformation.codeSymbol.symbolName);
				}
			} else {
				// We have a deleted file which we are tracking, time to evict this node
				nodesToEvict.add(codeSymbolInformation.codeSymbol.symbolName);
			}
		}
		const finalNodes = codeSymbolInformationList.filter((node) => {
			if (nodesToEvict.has(node.codeSymbol.symbolName)) {
				return false;
			}
			return true;
		});
		this._nodes = finalNodes;
		filesToReIndex.forEach((file) => {
			filesWhichNeedIndexing.add(file);
		});
		return Array.from(filesWhichNeedIndexing);
	}

	public async setupCodeGraph(): Promise<void> {
		// Here we can do multiple things, one of them being that we can load
		// the code symbols from the local storage and use that instead here.
		// This follows the same logic as what we were doing for the code symbol
		// generation.
		return;
	}

	public getNodeByLastName(
		lastName: string,
	): CodeSymbolInformation[] | null {
		const nodes = this._nodes.filter(
			(node) => {
				const symbolName = node.codeSymbol.symbolName;
				const splittedSymbolName = symbolName.split('.').reverse();
				let accumulator = '';
				for (let index = 0; index < splittedSymbolName.length; index++) {
					const element = splittedSymbolName[index];
					if (index === 0) {
						accumulator = element;
						if (accumulator === lastName) {
							return true;
						}
					} else {
						accumulator = `${element}.${accumulator}`;
						if (accumulator === lastName) {
							return true;
						}
					}
				}
				return false;
			},
		);
		if (nodes.length === 0) {
			return null;
		}
		return nodes.map((node) => node.codeSymbol);
	}

	public getNodeFromLineRangeAndFile(
		filePath: string,
		lineNumber: number,
	): CodeSymbolInformation | null {
		const nodes = this._nodes.filter(
			(node) => {
				if (node.codeSymbol.fsFilePath === filePath) {
					if (node.codeSymbol.symbolStartLine <= lineNumber && node.codeSymbol.symbolEndLine >= lineNumber) {
						return true;
					}
				}
				return false;
			},
		);
		if (nodes.length === 0) {
			return null;
		}
		return nodes[0].codeSymbol;
	}

	public getReferenceLocationsForCodeSymbol(
		node: CodeSymbolInformation,
	): CodeSymbolInformation[] {
		const references: CodeSymbolInformation[] = [];
		const nodeSymbolsForReference: Set<string> = new Set();
		for (const currentNode of this._nodes) {
			for (const edges of currentNode.codeSymbol.dependencies) {
				console.log(edges.edges.map((edge) => edge.codeSymbolName));
				console.log(edges.edges.map((edge) => edge.codeSymbolName).includes(node.symbolName));
				if (edges.edges.map((edge) => edge.codeSymbolName).includes(node.symbolName)) {
					if (nodeSymbolsForReference.has(currentNode.codeSymbol.symbolName) === false) {
						references.push(currentNode.codeSymbol);
						nodeSymbolsForReference.add(currentNode.codeSymbol.symbolName);
					}
				}
			}
		}
		return references;
	}
}


const parseFilesForCodeSymbols = async (
	codeSymbolsLanguageCollection: CodeSymbolsLanguageCollection,
	workingDirectory: string,
	filesToCheck: string[],
	emitter: EventEmitter,
): Promise<CodeGraphCodeSymbolInformation[]> => {
	const codeSymbolInformationList: CodeGraphCodeSymbolInformation[] = [];
	const crypto = await import('crypto');
	for (let index = 0; index < filesToCheck.length; index++) {
		const file = filesToCheck[index];
		try {
			const fileContent = await fs.promises.readFile(file, 'utf8');
			const fileContentHash = crypto.createHash('sha256').update(fileContent, 'utf8').digest('hex');
			const codeIndexer = codeSymbolsLanguageCollection.getIndexerForFile(file);
			if (codeIndexer === undefined) {
				continue;
			}
			const codeSymbols = await codeIndexer.parseFileWithDependencies(
				file,
				workingDirectory,
				true,
			);
			emitter.emit('partialData', codeSymbols);
			codeSymbolInformationList.push(...codeSymbols.map((codeSymbol) => {
				return {
					codeSymbol: codeSymbol,
					filePath: file,
					fileHash: fileContentHash,
				};
			}));
		} catch (error) {
			console.log('[parseFilesForCodeSymbols] error parsing file');
			console.log(error);
		}
	}
	return codeSymbolInformationList;
};


export const generateCodeGraph = async (
	codeSymbolsLanguageCollection: CodeSymbolsLanguageCollection,
	workingDirectory: string,
	emitter: EventEmitter,
	activeFileTracker: ActiveFilesTracker,
	storageLocation: string,
	repoName: string,
): Promise<CodeGraph> => {
	const filesToTrack = await getFilesTrackedInWorkingDirectory(
		workingDirectory,
	);
	const finalNodeList: CodeGraphCodeSymbolInformation[] = [];
	const codeSymbols = await parseFilesForCodeSymbols(
		codeSymbolsLanguageCollection,
		workingDirectory,
		filesToTrack,
		emitter,
	);
	finalNodeList.push(...codeSymbols);
	const codeGraph = new CodeGraph(
		activeFileTracker,
		storageLocation,
		repoName,
	);
	codeGraph.addNodes(finalNodeList);
	return codeGraph;
};
