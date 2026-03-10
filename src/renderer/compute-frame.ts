import { cyan, dim, red, yellow } from "@std/fmt/colors";
import stringWidth from "string-width";
import { formatDuration, formatFoldsProgress } from "../format.ts";
import {
  countFolds,
  durationMillis,
  findRunningLeaves,
  type FoldNode,
  logBytes,
} from "../fold-node.ts";

/** Options for computeFrame(). */
export type FrameOptions = {
  termWidth: number;
  termHeight: number;
  displayCounts: WeakMap<FoldNode, number>;
  now: number;
};

/** Result of computeFrame(). */
export type Frame = {
  lines: string[];
};

/** Truncate a string to fit within `maxWidth` visual columns, appending `…` if truncated. */
function truncateLine(line: string, maxWidth: number): string {
  const width = stringWidth(line);
  if (width <= maxWidth) {
    return line;
  }

  // Walk characters, accumulating visual width
  let result = "";
  let currentWidth = 0;
  for (const char of line) {
    const charWidth = stringWidth(char);
    if (currentWidth + charWidth > maxWidth - 1) {
      return result + "…";
    }
    result += char;
    currentWidth += charWidth;
  }
  return result;
}

type TailAssignment = {
  node: FoldNode;
  lines: number;
};

type RankedLeaf = {
  node: FoldNode;
  score: number;
};

function calculateTailAssignments(
  termHeight: number,
  foldLines: string[],
  rankedRunningLeaves: RankedLeaf[],
): TailAssignment[] {
  // Calculate available viewport lines
  let free = termHeight - foldLines.length - 2;
  if (free < 0) {
    free = 0;
  }

  // Assign tail windows greedily
  const tailAssignments: TailAssignment[] = [];
  for (const { node } of rankedRunningLeaves) {
    if (free <= 0) {
      break;
    }

    const maxTail = node.tailLines;
    if (maxTail === 0) {
      continue;
    }

    const cost = maxTail + 1; // tail lines + visual padding
    if (cost <= free) {
      tailAssignments.push({ node, lines: maxTail });
      free -= cost;
      continue;
    }

    // Reduced allocation for the last candidate
    const reduced = free - 1; // at least 1 line of tail
    if (reduced > 0) {
      tailAssignments.push({ node, lines: reduced });
      free = 0;
    }
  }
  return tailAssignments;
}

/**
 * Computes a frame for the TTY renderer.
 * Reads per-fold tailLines, spinner, composedFlatMap directly from each FoldNode.
 * Mutates displayCounts in place.
 */
export function computeFrame(root: FoldNode, options: FrameOptions): Frame {
  const { termWidth, termHeight, displayCounts, now } = options;

  // Step 1: Task lines (recursive walk)
  const foldLines: string[] = [];

  // Track which running leaves have fold lines, and their indent for tail rendering
  const runningLeafIndents = new Map<FoldNode, string>();

  function renderNode(node: FoldNode, displayDepth: number): void {
    const indent = "  ".repeat(displayDepth);

    // Title-less folds: skip node's own line, recurse children at same displayDepth
    if (node.title === undefined) {
      for (const child of node.children) {
        renderNode(child, displayDepth);
      }
      return;
    }

    const title = node.title;
    const ms = durationMillis(node);
    const duration = ms !== undefined ? formatDuration(ms) : "";

    switch (node.status) {
      case "pending":
        // Not shown
        return;

      case "success":
        foldLines.push(
          truncateLine(
            `${indent}${dim(cyan(`✓ ${title}  ${duration}`))}`,
            termWidth,
          ),
        );
        return;

      case "warning":
        foldLines.push(
          truncateLine(
            `${indent}${yellow(`⚠ ${title}  ${duration}`)}`,
            termWidth,
          ),
        );
        return;

      case "fail":
        foldLines.push(
          truncateLine(
            `${indent}${red(`✗ ${title}  ERROR  ${duration}`)}`,
            termWidth,
          ),
        );
        return;

      case "skipped":
        foldLines.push(
          truncateLine(`${indent}${dim(`⊘ ${title}`)}`, termWidth),
        );
        return;

      case "running": {
        // Spinner frame
        const { spinner } = node;
        const frameIndex = Math.floor(now / spinner.interval) %
          spinner.frames.length;
        const frame = spinner.frames[frameIndex];

        // Root running fold shows (C/N) progress
        const progress = node.parent
          ? ""
          : ` (${formatFoldsProgress(countFolds(root))})`;

        foldLines.push(
          truncateLine(
            `${indent}${frame} ${title}  ${duration}${progress}`,
            termWidth,
          ),
        );

        // Track running leaf indent for tail window
        const hasRunningChild = node.children.some((c) =>
          c.status === "running"
        );
        if (!hasRunningChild && node.logLines.length > 0) {
          runningLeafIndents.set(node, indent);
        }

        // Recurse into children
        for (const child of node.children) {
          renderNode(child, displayDepth + 1);
        }
        return;
      }
    }
  }

  renderNode(root, 0);

  // Step 2: Log tail windows (competitive allocation)
  const runningLeaves = findRunningLeaves(root)
    .filter((n) => n.logLines.length > 0); // Only consider those with logs for tail display;

  // Rank by activity: logBytes + displayCount * 50
  const rankedRunningLeaves = runningLeaves
    .map((node) => ({
      node,
      score: logBytes(node) + (displayCounts.get(node) ?? 0) * 50,
    }))
    .sort((a, b) => b.score - a.score);

  const tailAssignments = calculateTailAssignments(
    termHeight,
    foldLines,
    rankedRunningLeaves,
  );

  // Update displayCounts for nodes whose tails are shown
  for (const { node } of tailAssignments) {
    const prev = displayCounts.get(node) ?? 0;
    displayCounts.set(node, prev + 1);
  }

  // Build tail line sections and insert after corresponding fold lines
  // We need to find where each running leaf's fold line is and insert tail after it
  const allLines: string[] = [];

  // Rebuild: walk the tree again to interleave fold lines and tail lines
  let foldLineIndex = 0;

  function emitNode(node: FoldNode, displayDepth: number): void {
    const indent = "  ".repeat(displayDepth);

    if (node.title === undefined) {
      for (const child of node.children) {
        emitNode(child, displayDepth);
      }
      return;
    }

    if (node.status === "pending") {
      return;
    }

    // Emit the fold line
    if (foldLineIndex < foldLines.length) {
      allLines.push(foldLines[foldLineIndex]);
      foldLineIndex++;
    }

    if (node.status === "running") {
      // Check if this node has a tail assignment
      const assignment = tailAssignments.find((a) => a.node === node);
      if (assignment) {
        // Get tail lines through composedFlatMap
        const mappedLines: string[] = node.logLines
          .flatMap(node.composedFlatMap);

        const tail = mappedLines.slice(-assignment.lines);
        for (const line of tail) {
          allLines.push(
            truncateLine(`${indent}${dim(`│ ${line}`)}`, termWidth),
          );
        }
        // Visual padding (blank line after tail)
        allLines.push("");
      }

      // Recurse into children
      for (const child of node.children) {
        emitNode(child, displayDepth + 1);
      }
    }
  }

  emitNode(root, 0);

  // Step 3: Viewport fitting
  if (allLines.length > termHeight) {
    // First: already handled by reducing tails above
    // Second: drop completed folds from oldest first
    // Third: never drop running folds

    // Simple approach: keep lines up to termHeight, preserving running folds
    const trimmed = fitViewport(allLines, termHeight);
    return { lines: trimmed };
  }

  return { lines: allLines };
}

/** Fit lines to viewport height by dropping completed folds. */
function fitViewport(
  lines: string[],
  maxHeight: number,
): string[] {
  // Simple truncation: take the last maxHeight lines to keep recent/running folds visible
  if (lines.length <= maxHeight) {
    return lines;
  }
  return lines.slice(lines.length - maxHeight);
}
