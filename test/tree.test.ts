import { expect, test } from 'bun:test';
import { formatTree, formatTreeMarkdown } from '../src/tree.ts';
import type { SubagentTreeNode } from '../src/types.ts';

const root: SubagentTreeNode = {
	sessionId: 'synthetic-root',
	label: 'synthetic-agent',
	selfCost: 3,
	totalCost: 3,
	children: [],
	turnCount: 1,
};

test('tree headings describe displayed nodes as roots', () => {
	const text = formatTree([root], 3);
	const markdown = formatTreeMarkdown([root], 3);

	expect(text).toContain(' roots by total cost');
	expect(text).not.toContain('orchestrators');
	expect(markdown).toContain('Top 1 roots by total cost.');
	expect(markdown).not.toContain('orchestrators');
});
