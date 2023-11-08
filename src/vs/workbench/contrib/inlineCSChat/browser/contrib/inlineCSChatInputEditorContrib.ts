/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { Disposable } from 'vs/base/common/lifecycle';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { getWordAtText } from 'vs/editor/common/core/wordHelper';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionList } from 'vs/editor/common/languages';
import { ITextModel } from 'vs/editor/common/model';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Registry } from 'vs/platform/registry/common/platform';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { chatFileVariableLeader } from 'vs/workbench/contrib/csChat/common/csChatParserTypes';
import { SelectAndInsertFileAction } from 'vs/workbench/contrib/inlineCSChat/browser/contrib/inlineCSChatDynamicReferences';
import { InlineChatController } from 'vs/workbench/contrib/inlineCSChat/browser/inlineCSChatController';
import { InlineChatWidget } from 'vs/workbench/contrib/inlineCSChat/browser/inlineCSChatWidget';
import { getOutOfWorkspaceEditorResources } from 'vs/workbench/contrib/search/common/search';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { QueryBuilder } from 'vs/workbench/services/search/common/queryBuilder';
import { ISearchComplete, ISearchService } from 'vs/workbench/services/search/common/search';

class BuiltinDynamicCompletions extends Disposable {
	private static readonly VariableNameDef = new RegExp(`${chatFileVariableLeader}\\w*`, 'g'); // MUST be using `g`-flag

	private readonly fileQueryBuilder = this.instantiationService.createInstance(QueryBuilder);

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();

		this._register(this.languageFeaturesService.completionProvider.register({ scheme: InlineChatWidget.INPUT_SCHEME, hasAccessToAllModels: true }, {
			_debugDisplayName: 'inlineChatDynamicCompletions',
			triggerCharacters: [chatFileVariableLeader],
			provideCompletionItems: async (model: ITextModel, position: Position, _context: CompletionContext, _token: CancellationToken) => {
				const codeEditor = this.codeEditorService.getActiveCodeEditor();
				const codeEditorModel = codeEditor && codeEditor.getModel();
				if (!codeEditorModel) {
					return null;
				}

				const inlineChatEditor = this.codeEditorService.getFocusedCodeEditor();
				if (!inlineChatEditor) {
					return null;
				}

				const widget = InlineChatController.get(codeEditor)?.getWidget();

				const varWord = getWordAtText(position.column, BuiltinDynamicCompletions.VariableNameDef, model.getLineContent(position.lineNumber), 0);
				if (!varWord && model.getWordUntilPosition(position).word) {
					// inside a "normal" word
					return null;
				}

				const files = await this.doGetFileSearchResults(_token);
				const insertAndReplaceRange = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
				const range = new Range(position.lineNumber, position.column - (varWord ? varWord.word.length : 0), position.lineNumber, position.column);

				// Map the file list to completion items
				const completionURIs = files.results.map(result => result.resource);
				const completionItems = completionURIs.map(uri => {
					const path = uri.path;
					const label = path.substring(path.lastIndexOf('/') + 1);

					return <CompletionItem>{
						label,
						insertText: '',
						detail: uri.fsPath,
						range: { insert: insertAndReplaceRange, replace: insertAndReplaceRange },
						kind: CompletionItemKind.Text,
						command: { id: SelectAndInsertFileAction.ID, title: SelectAndInsertFileAction.ID, arguments: [{ range, uri, widget }] },
					};
				});


				return <CompletionList>{
					suggestions: completionItems
				};
			}
		}));
	}

	private doGetFileSearchResults(token: CancellationToken): Promise<ISearchComplete> {
		return this.searchService.fileSearch(
			this.fileQueryBuilder.file(
				this.contextService.getWorkspace().folders,
				{
					extraFileResources: this.instantiationService.invokeFunction(getOutOfWorkspaceEditorResources),
					sortByScore: true,
				}
			), token);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(BuiltinDynamicCompletions, LifecyclePhase.Eventually);
