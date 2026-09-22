/** Syntactic module dependencies; explicit type-only edges stay separate from value-capable edges. */
import ts from 'typescript';
import { posix } from 'node:path';

export interface SourceFile { path: string; source: string }
export interface Dependency { specifier: string; typeOnly: boolean; line: number }
export interface SourceDependencies {
  dependencies: Dependency[];
  unresolved: number[];
  typesOnly: boolean;
}

function typeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return !clause.name && named !== undefined && ts.isNamedImports(named)
    && named.elements.length > 0 && named.elements.every(item => item.isTypeOnly);
}

function typeExport(node: ts.ExportDeclaration): boolean {
  return node.isTypeOnly || node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
}

/** Read syntax, not text matching. Value imports are conservative even when used only in types. */
export function sourceDependencies(file: SourceFile): SourceDependencies {
  const source = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const dependencies: Dependency[] = [];
  const unresolved: number[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (value: ts.Node | undefined, typeOnly: boolean, node: ts.Node) => {
    if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
      dependencies.push({ specifier: value.text, typeOnly, line: line(node) });
    } else unresolved.push(line(node));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, typeImport(node), node);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, typeExport(node), node);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly, node);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true, node);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      add(node.arguments[0], false, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const typesOnly = source.statements.every(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || ts.isEmptyStatement(node) || ts.isImportDeclaration(node) && typeImport(node)
    || ts.isExportDeclaration(node) && typeExport(node)
    || ts.isImportEqualsDeclaration(node) && node.isTypeOnly);
  return { dependencies, unresolved, typesOnly };
}

export interface DependencyEdge extends Dependency { from: string; to: string }

/** Resolve local edges against the actual source tree; missing targets must not disappear from the graph. */
export function dependencyGraph(files: readonly SourceFile[]): { edges: DependencyEdge[]; problems: string[] } {
  const paths = new Set(files.map(file => file.path));
  const edges: DependencyEdge[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const parsed = sourceDependencies(file);
    for (const line of parsed.unresolved) problems.push(`${file.path}:${line}: module target must be a literal`);
    for (const dependency of parsed.dependencies) {
      if (!dependency.specifier.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(file.path), dependency.specifier));
      const candidates = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'),
        `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
      const resolved = candidates.find(candidate => paths.has(candidate));
      if (resolved) edges.push({ ...dependency, from: file.path, to: resolved });
      else problems.push(`${file.path}:${dependency.line}: unresolved local module ${dependency.specifier}`);
    }
  }
  return { edges, problems };
}

/** Strongly connected components, sorted for stable review; a self import is also a cycle. */
export function dependencyCycles(edges: readonly DependencyEdge[], includeTypes = false): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!includeTypes && edge.typeOnly) continue;
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    graph.get(edge.from)!.add(edge.to);
  }
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const cycles: string[][] = [];
  const visit = (node: string) => {
    indices.set(node, index); low.set(node, index++); stack.push(node); active.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) { visit(target); low.set(node, Math.min(low.get(node)!, low.get(target)!)); }
      else if (active.has(target)) low.set(node, Math.min(low.get(node)!, indices.get(target)!));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let target: string;
    do { target = stack.pop()!; active.delete(target); component.push(target); } while (target !== node);
    if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.sort());
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}
