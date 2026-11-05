// ASCII tree renderer for subagent graph (the MOAT feature).
// Helicone/Langfuse observe API calls; only Claude Code knows that
// orchestrator → 3×researcher + 6×swift-dev. We render that tree.

import type { SubagentTreeNode } from './types.ts';

const fmtUsd = (n: number): string => {
	if (n < 0.01) return '$' + n.toFixed(4);
	return '$' + n.toFixed(2);
};

const dim = (s: string): string =>
	process.env.NO_COLOR || !process.stdout.isTTY ? s : `\x1b[2m${s}\x1b[0m`;

const bold = (s: string): string =>
	process.env.NO_COLOR || !process.stdout.isTTY ? s : `\x1b[1m${s}\x1b[0m`;

const amber = (s: string): string =>
	process.env.NO_COLOR || !process.stdout.isTTY ? s : `\x1b[38;5;215m${s}\x1b[0m`;

export function formatTree(roots: SubagentTreeNode[], totalCost: number): string {
	if (roots.length === 0) return dim('No subagent graphs found in this period.');

	const lines: string[] = [];
	lines.push(
		bold('Subagent graphs') +
			dim('  · top ') +
			roots.length +
			dim(' roots by total cost · grand-total ') +
			amber(fmtUsd(totalCost)),
	);
	lines.push('');
	for (const root of roots) {
		renderNode(root, '', true, lines, totalCost, true);
		lines.push('');
	}
	return lines.join('\n');
}

function renderNode(
	node: SubagentTreeNode,
	prefix: string,
	isLast: boolean,
	lines: string[],
	grandTotal: number,
	isRoot: boolean,
): void {
	const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
	const sessionShort = dim(node.sessionId.slice(0, 8));
	const pct = grandTotal > 0 ? ((node.totalCost / grandTotal) * 100).toFixed(1) + '%' : '—';
	const turns = dim(`${node.turnCount} turns`);

	if (isRoot) {
		const childCount = countDescendants(node);
		const childInfo = childCount > 0 ? dim(` (${childCount} children)`) : '';
		lines.push(
			`${bold(node.label)} ${sessionShort}${childInfo}  ${amber(fmtUsd(node.totalCost))}  ${dim(`(${pct})`)}`,
		);
	} else {
		const selfNote =
			node.children.length > 0
				? dim(`  self ${fmtUsd(node.selfCost)}`)
				: '';
		lines.push(
			`${dim(prefix)}${connector}${node.label} ${sessionShort}  ${amber(fmtUsd(node.totalCost))}${selfNote}  ${turns}`,
		);
	}

	const childPrefix = prefix + (isRoot ? '' : isLast ? '   ' : '│  ');
	node.children.forEach((child, idx) => {
		const last = idx === node.children.length - 1;
		renderNode(child, childPrefix, last, lines, grandTotal, false);
	});
}

function countDescendants(node: SubagentTreeNode): number {
	let n = node.children.length;
	for (const c of node.children) n += countDescendants(c);
	return n;
}

// Markdown variant — same data, GH-friendly nested list.
export function formatTreeMarkdown(roots: SubagentTreeNode[], totalCost: number): string {
	const lines: string[] = ['# Subagent graphs', ''];
	lines.push(`Top ${roots.length} roots by total cost. Grand total: **${fmtUsd(totalCost)}**.`);
	lines.push('');
	for (const root of roots) {
		const childCount = countDescendants(root);
		lines.push(
			`## ${root.label} \`${root.sessionId.slice(0, 8)}\` — ${fmtUsd(root.totalCost)} (${childCount} children, ${root.turnCount} turns)`,
		);
		mdNode(root, lines, 0);
		lines.push('');
	}
	return lines.join('\n');
}

function mdNode(node: SubagentTreeNode, lines: string[], depth: number): void {
	for (const child of node.children) {
		const indent = '  '.repeat(depth);
		const self = child.children.length > 0 ? ` _self ${fmtUsd(child.selfCost)}_` : '';
		lines.push(
			`${indent}- **${child.label}** \`${child.sessionId.slice(0, 8)}\` — ${fmtUsd(child.totalCost)} (${child.turnCount} turns)${self}`,
		);
		mdNode(child, lines, depth + 1);
	}
}
