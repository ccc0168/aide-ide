/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	OpenAI
} from 'openai';


import {
	encode,
	encodeChat,
	decode,
	isWithinTokenLimit,
	encodeGenerator,
	decodeGenerator,
	decodeAsyncGenerator,
} from 'gpt-tokenizer';


const chatSystemPrompt = (): string => {
	return 'Your name is CodeStory bot. You are a brilliant and meticulous engineer assigned to write code for the following Github issue. When you write code, the code works on the first try and is formatted perfectly. You have the utmost care for the code that you write, so you do not make mistakes. Take into account the current repository\'s language, frameworks, and dependencies. You must always use markdown when referring to code symbols.';
};


type RoleString = 'system' | 'user' | 'assistant' | undefined;
type RoleStringForOpenai = 'system' | 'user' | 'assistant' | 'function';


const convertRoleToString = (role: RoleStringForOpenai): RoleString => {
	switch (role) {
		case 'system':
			return 'system';
		case 'user':
			return 'user';
		case 'assistant':
			return 'assistant';
		default:
			return undefined;
	}
};


export class CSChatState {
	private _messages: OpenAI.Chat.CreateChatCompletionRequestMessage[];
	private _tokenLimit: number;

	constructor() {
		this._messages = [];
		this._tokenLimit = 1000;
		this.addSystemPrompt();
	}

	cleanupChatHistory(): void {
		// we want to do the following:
		// we want to have atleast 1k tokens for the completion
		// we will obviously need the system prompt so we will always keep that
		// after that going backwards we will store the messages(user + assistant) until we reach 6k tokens
		// we will then remove the rest of the messages
		const messages = this._messages.map((message) => {
			return {
				role: convertRoleToString(message.role),
				content: message.content ?? '',
			};
		});
		const finalMessages: OpenAI.Chat.CreateChatCompletionRequestMessage[] = [];
		const maxTokenLimit = 6000;
		// Now we walk backwards
		let totalTokenCount = encode(chatSystemPrompt()).length;
		for (let index = messages.length - 1; index > 0; index--) {
			const message = messages[index];
			const messageTokenCount = encode(message.content).length;
			if (totalTokenCount + messageTokenCount > maxTokenLimit) {
				break;
			}
			totalTokenCount += messageTokenCount;
			finalMessages.push(this._messages[index]);
		}
		finalMessages.push(
			{
				role: 'system',
				content: chatSystemPrompt(),
			}
		);
		finalMessages.reverse();
		this._messages = finalMessages;
	}

	getMessages(): OpenAI.Chat.CreateChatCompletionRequestMessage[] {
		return this._messages;
	}

	getMessageLength(): number {
		return this._messages.length;
	}

	addSystemPrompt(): void {
		this._messages.push({
			role: 'system',
			content: chatSystemPrompt(),
		});
	}

	addUserMessage(message: string): void {
		this._messages.push({
			role: 'user',
			content: message,
		});
	}

	addCodeStoryMessage(message: string): void {
		this._messages.push({
			role: 'assistant',
			content: message,
		});
	}

	addCodeContext(codeContext: string, extraSurroundingContext: string): void {
		this._messages.push({
			role: 'user',
			content: `
The code in question is the following:
<code_context>
${codeContext}
</code_context>

The surrounding code for the code in question is the following:
<code_context_surrounding>
${extraSurroundingContext}
</code_context_surrounding>
			`,
		});
	}

	addExplainCodeContext(codeContext: string): void {
		this._messages.push({
			role: 'user',
			content: codeContext,
		});
	}
}
