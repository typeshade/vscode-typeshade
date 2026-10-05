// === The `&` at an argument the callee writes back ===
//
// The compiler's change 0040 lets a function of the file declare a parameter `@inout` or `@out`:
// the parameter names the caller's place, and the call passes the variable unmarked, as GLSL and
// HLSL do (`swap(x, y)`). The source no longer shows at the call that `x` may change, so the
// editor shows it: an inlay hint `&` before each argument such a parameter takes.
//
// The compiler delivers no inlay hint (0040, deviation 7: a new method of the language service
// would reshape a public export the proposal does not declare). The qualifier is a decorator on
// the callee's declaration in the source, so the plugin reads it from the syntax tsserver already
// parsed, as `identifierAt` and `argumentSpan` in `decorate.ts` do.
//
// What resolves is what a qualifier may be written on (the compiler's Rule 8.25, surface §70): a
// function declared at the top of the file or of a namespace, called by its name (`swap(x, y)`)
// or through the namespaces around it (`N.f(x)`, `A.B.f(x)`). The name is resolved as TypeScript
// resolves it, from where the call is written, so a parameter, a local or a local function of
// the same name hides the declaration and the call gets no hint. A function imported from
// another file is not resolved here, and gets no hint (`docs/design.md` §3).

import type ts from 'typescript';

/** The qualifiers whose argument is a place the callee writes. GLSL's third, `in`, is no
 *  qualifier here: TypeScript does not parse `@in`, and a parameter with none is GLSL's `in`. */
const WRITES_BACK: ReadonlySet<string> = new Set(['inout', 'out']);

/** What a name means in one scope, as far as a call's hint needs to know. */
type Meaning =
  | { readonly kind: 'function'; readonly declaration: ts.FunctionDeclaration }
  | { readonly kind: 'namespace'; readonly declarations: readonly ts.ModuleDeclaration[] }
  | { readonly kind: 'other' };

/**
 * The `&` hints for every call in `span` whose callee takes an argument by `@inout` or `@out`.
 *
 * @param typescript - the host's own `typescript` module, whose `SyntaxKind` table the nodes of
 *   `sourceFile` carry.
 * @param sourceFile - the file tsserver parsed.
 * @param span - the part of the file the editor shows, which is what tsserver asks about.
 * @returns one hint at the start of each such argument inside the span, in source order.
 */
export function referenceHints(
  typescript: typeof ts,
  sourceFile: ts.SourceFile,
  span: ts.TextSpan,
): ts.InlayHint[] {
  const end = span.start + span.length;
  const hints: ts.InlayHint[] = [];

  const visit = (node: ts.Node): void => {
    // A node wholly outside the span holds no argument inside it.
    if (node.end < span.start || node.getStart(sourceFile) > end) return;
    if (typescript.isCallExpression(node)) {
      const callee = resolveCallee(typescript, node.expression);
      if (callee !== undefined) {
        node.arguments.forEach((argument, index) => {
          const parameter = callee.parameters[index];
          if (parameter === undefined || parameter.dotDotDotToken !== undefined) return;
          if (!writesBack(typescript, parameter)) return;
          const position = argument.getStart(sourceFile);
          if (position < span.start || position > end) return;
          hints.push({
            text: '&',
            position,
            kind: typescript.InlayHintKind.Parameter,
            whitespaceBefore: false,
            whitespaceAfter: false,
          });
        });
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return hints;
}

/** Whether a parameter carries `@inout` or `@out`. */
function writesBack(typescript: typeof ts, parameter: ts.ParameterDeclaration): boolean {
  const decorators = typescript.getDecorators(parameter) ?? [];
  return decorators.some(
    (decorator) =>
      typescript.isIdentifier(decorator.expression) && WRITES_BACK.has(decorator.expression.text),
  );
}

/** The function declaration a call's callee names, when it is one a qualifier may be written
 *  on; undefined for anything else. */
function resolveCallee(
  typescript: typeof ts,
  expression: ts.Expression,
): ts.FunctionDeclaration | undefined {
  const callee = stripParentheses(typescript, expression);
  if (typescript.isIdentifier(callee)) {
    const meaning = lookUp(typescript, callee, callee.text);
    return meaning?.kind === 'function' ? meaning.declaration : undefined;
  }
  // `A.B.f`: every link a plain name, the first one a namespace in scope.
  const path: ts.Identifier[] = [];
  let link: ts.Expression = callee;
  while (typescript.isPropertyAccessExpression(link)) {
    if (!typescript.isIdentifier(link.name)) return undefined;
    path.unshift(link.name);
    link = stripParentheses(typescript, link.expression);
  }
  if (!typescript.isIdentifier(link) || path.length === 0) return undefined;
  let meaning = lookUp(typescript, link, link.text);
  for (const name of path) {
    if (meaning?.kind !== 'namespace') return undefined;
    meaning = exportedMember(typescript, meaning.declarations, name.text);
  }
  return meaning?.kind === 'function' ? meaning.declaration : undefined;
}

/** `(f)` as `f`. */
function stripParentheses(typescript: typeof ts, expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (typescript.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** What `name` means where `from` is written: the innermost scope that declares it decides. */
function lookUp(typescript: typeof ts, from: ts.Node, name: string): Meaning | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope !== undefined; scope = scope.parent) {
    if (typescript.isFunctionLike(scope)) {
      for (const parameter of scope.parameters) {
        if (bindsName(typescript, parameter.name, name)) return { kind: 'other' };
      }
      // A function expression's own name is in scope inside it.
      if (
        (typescript.isFunctionExpression(scope) || typescript.isClassExpression(scope)) &&
        scope.name?.text === name
      ) {
        return { kind: 'other' };
      }
    }
    if (
      (typescript.isForStatement(scope) ||
        typescript.isForOfStatement(scope) ||
        typescript.isForInStatement(scope)) &&
      scope.initializer !== undefined &&
      typescript.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((d) => bindsName(typescript, d.name, name))
    ) {
      return { kind: 'other' };
    }
    if (typescript.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
      if (bindsName(typescript, scope.variableDeclaration.name, name)) return { kind: 'other' };
    }
    const statements = statementsOf(typescript, scope);
    if (statements === undefined) continue;
    // Only the file and a namespace hold functions a qualifier may be written on; a function
    // declared in a block is a local function, which takes its parameters by value.
    const declaresFunctions = typescript.isSourceFile(scope) || typescript.isModuleBlock(scope);
    const here = meaningIn(typescript, statements, name, declaresFunctions);
    if (here !== undefined) return here;
    // Inside `namespace N { ... }`, what another block of `N` exports is in scope too.
    if (typescript.isModuleBlock(scope)) {
      const siblings = sameNamespace(typescript, scope.parent);
      const merged = exportedMember(typescript, siblings, name);
      if (merged !== undefined) return merged;
    }
  }
  return undefined;
}

/** The statements a scope declares names in, or undefined for a node that is no such scope. */
function statementsOf(typescript: typeof ts, node: ts.Node): readonly ts.Statement[] | undefined {
  if (
    typescript.isSourceFile(node) ||
    typescript.isBlock(node) ||
    typescript.isModuleBlock(node) ||
    typescript.isCaseClause(node) ||
    typescript.isDefaultClause(node)
  ) {
    return node.statements;
  }
  return undefined;
}

/** What one list of statements declares `name` as, or undefined when it does not declare it. */
function meaningIn(
  typescript: typeof ts,
  statements: readonly ts.Statement[],
  name: string,
  declaresFunctions: boolean,
): Meaning | undefined {
  const functions: ts.FunctionDeclaration[] = [];
  const namespaces: ts.ModuleDeclaration[] = [];
  let other = false;
  for (const statement of statements) {
    if (typescript.isFunctionDeclaration(statement) && statement.name?.text === name) {
      functions.push(statement);
    } else if (
      typescript.isModuleDeclaration(statement) &&
      typescript.isIdentifier(statement.name) &&
      statement.name.text === name
    ) {
      namespaces.push(statement);
    } else if (declaresName(typescript, statement, name)) {
      other = true;
    }
  }
  if (other) return { kind: 'other' };
  if (functions.length > 0) {
    if (!declaresFunctions) return { kind: 'other' };
    // An overload list ends with the implementation, whose parameters carry the qualifiers.
    const declaration = functions.find((f) => f.body !== undefined) ?? functions[0];
    return { kind: 'function', declaration };
  }
  if (namespaces.length > 0) return { kind: 'namespace', declarations: namespaces };
  return undefined;
}

/** Whether a statement other than a function or a namespace declares `name`. */
function declaresName(typescript: typeof ts, statement: ts.Statement, name: string): boolean {
  if (typescript.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((d) => bindsName(typescript, d.name, name));
  }
  if (
    typescript.isClassDeclaration(statement) ||
    typescript.isEnumDeclaration(statement) ||
    typescript.isInterfaceDeclaration(statement) ||
    typescript.isTypeAliasDeclaration(statement)
  ) {
    // An interface or a type alias names a type, not a value, so a call cannot reach one; it is
    // counted only so that a value of another kind is never taken in its place.
    return statement.name?.text === name;
  }
  if (typescript.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return false;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    if (typescript.isNamespaceImport(bindings)) return bindings.name.text === name;
    return bindings.elements.some((element) => element.name.text === name);
  }
  if (typescript.isImportEqualsDeclaration(statement)) return statement.name.text === name;
  return false;
}

/** Whether a binding name, a destructuring pattern included, binds `name`. */
function bindsName(typescript: typeof ts, binding: ts.BindingName, name: string): boolean {
  if (typescript.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      !typescript.isOmittedExpression(element) && bindsName(typescript, element.name, name),
  );
}

/** Every declaration of the namespace `declaration` belongs to, in the scope that holds it. */
function sameNamespace(
  typescript: typeof ts,
  declaration: ts.ModuleDeclaration,
): readonly ts.ModuleDeclaration[] {
  const holder = declaration.parent;
  // `namespace A.B { }` nests B's declaration directly in A's: no other block of `A.B` merges.
  const statements = statementsOf(typescript, holder);
  if (statements === undefined) return [declaration];
  return statements.filter(
    (statement): statement is ts.ModuleDeclaration =>
      typescript.isModuleDeclaration(statement) &&
      typescript.isIdentifier(statement.name) &&
      statement.name.text === (declaration.name as ts.Identifier).text,
  );
}

/** What the namespace whose declarations are `declarations` exports as `name`. */
function exportedMember(
  typescript: typeof ts,
  declarations: readonly ts.ModuleDeclaration[],
  name: string,
): Meaning | undefined {
  const functions: ts.FunctionDeclaration[] = [];
  const namespaces: ts.ModuleDeclaration[] = [];
  for (const declaration of declarations) {
    const body = declaration.body;
    if (body === undefined) continue;
    // `namespace A.B { }`: B is a member of A, exported by the dotted form itself.
    if (typescript.isModuleDeclaration(body)) {
      if (typescript.isIdentifier(body.name) && body.name.text === name) namespaces.push(body);
      continue;
    }
    if (!typescript.isModuleBlock(body)) continue;
    for (const statement of body.statements) {
      if (!isExported(typescript, statement)) continue;
      if (typescript.isFunctionDeclaration(statement) && statement.name?.text === name) {
        functions.push(statement);
      } else if (
        typescript.isModuleDeclaration(statement) &&
        typescript.isIdentifier(statement.name) &&
        statement.name.text === name
      ) {
        namespaces.push(statement);
      } else if (declaresName(typescript, statement, name)) {
        return { kind: 'other' };
      }
    }
  }
  if (functions.length > 0) {
    const declaration = functions.find((f) => f.body !== undefined) ?? functions[0];
    return { kind: 'function', declaration };
  }
  if (namespaces.length > 0) return { kind: 'namespace', declarations: namespaces };
  return undefined;
}

/** Whether a statement carries `export`. */
function isExported(typescript: typeof ts, statement: ts.Statement): boolean {
  const modifiers = typescript.canHaveModifiers(statement)
    ? typescript.getModifiers(statement)
    : undefined;
  return modifiers?.some((m) => m.kind === typescript.SyntaxKind.ExportKeyword) ?? false;
}
