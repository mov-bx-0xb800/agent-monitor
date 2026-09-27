/* Pure subject extraction shared by the collector and tests. A subject is a unit of work, not a
   file: a module, its test and its styles are one subject, so breadth counts distinct work. */
(function (root) {
  const generic = new Set([
    'src',
    'lib',
    'app',
    'apps',
    'packages',
    'services',
    'components',
    'screens',
    'views',
    'pages',
    'api',
    'server',
    'client',
    'tests',
    'test',
    'spec',
    'specs',
    'e2e',
    '__tests__',
    '__mocks__',
    '__snapshots__',
    'fixtures',
    'docs',
    'public',
    'assets',
    'utils',
    'helpers',
    'internal',
    'include',
    'main',
    'java',
    'kotlin',
    'com',
    'org',
    'net',
    'io',
  ]);
  const names = {
    auth: 'Authentication',
    a11y: 'Accessibility',
    ci: 'Build pipeline',
    readme: 'Project documentation',
    changelog: 'Release notes',
    dockerfile: 'Container setup',
    package: 'Dependencies',
    pyproject: 'Python project',
    cargo: 'Rust project',
    cmakelists: 'CMake configuration',
  };
  const CHECKS = {
    test: 'Test run',
    static: 'Static checks',
    benchmark: 'Benchmark',
    security: 'Security scan',
    build: 'Build',
    accessibility: 'Accessibility check',
    docs: 'Documentation build',
  };
  function human(value) {
    const s = String(value)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // File names such as constructor.js must not resolve through the object prototype.
    const known = Object.hasOwn(names, s.toLowerCase()) ? names[s.toLowerCase()] : null;
    return known || s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Removes test, story, style and declaration markers so related files share one stem.
  function stemOf(file) {
    let s = file.replace(/\.[^.]+$/, '');
    for (let i = 0; i < 3; i++)
      s = s.replace(
        /\.(test|spec|stories|story|module|styles?|d|bench|cy|e2e|unit|int|integration|mocks?|fixtures?|snap|tsx|ts|jsx|js)$/i,
        '',
      );
    return s.replace(/^(test_|spec_)/i, '').replace(/(_test|_spec|(?<=[a-z0-9])Tests?)$/, '');
  }
  // Generic folders, route groups such as (auth) and dynamic segments such as [id] do not name work.
  const skipped = (s) => generic.has(s.toLowerCase()) || /^[[(].*[\])]$/.test(s) || s === '..';
  function subject(target, tool = '', command = null) {
    const p = String(target || '')
      .replaceAll('\\', '/')
      .replace(/\?.*$/, '')
      .replace(/\/+$/, '');
    if (!p || p === tool) {
      if (command?.check)
        return {
          title: (Object.hasOwn(CHECKS, command.check) && CHECKS[command.check]) || 'Check',
          key: 'check:' + command.check + ':' + (command.label || tool),
        };
      if (command?.label) return { title: human(command.label), key: 'command:' + command.label };
      return {
        title: /search|browse|fetch|research/i.test(tool)
          ? 'Source research'
          : /screenshot|image|figma|snapshot|browser/i.test(tool)
            ? 'Visual material'
            : /plan|todo/i.test(tool)
              ? 'Task planning'
              : /Bash|shell|exec_command/.test(tool)
                ? 'Command activity'
                : 'Tool activity',
        key: 'tool:' + tool,
      };
    }
    const parts = p.split('/').filter((s) => s && s !== '.');
    // A glob names a search over a directory, not a file.
    const wild = parts.findIndex((s) => /[*?{]/.test(s));
    if (wild >= 0) {
      const dir = parts
        .slice(0, wild)
        .reverse()
        .find((s) => !skipped(s));
      return {
        title: dir ? human(dir).slice(0, 80) : 'File search',
        key: 'glob:' + parts.slice(0, wild).join('/'),
      };
    }
    // Feature/module boundaries are stronger subjects than incidental filenames inside them.
    for (const marker of ['features', 'modules', 'domains']) {
      const i = parts.indexOf(marker);
      if (i >= 0 && i + 1 < parts.length - 1)
        return { title: human(parts[i + 1]), key: parts.slice(i, i + 2).join('/') };
    }
    if (parts.slice(0, -1).includes('auth'))
      return {
        title: 'Authentication',
        key: parts
          .slice(0, parts.lastIndexOf('auth') + 1)
          .filter((s) => !skipped(s))
          .join('/'),
      };
    const stem = stemOf(parts.at(-1) || ''),
      dirs = parts.slice(0, -1);
    if (
      !/^(index|page|route|layout|main|init|__init__|test|spec|schema|types|utils|helpers|config|mod|lib)$/i.test(
        stem,
      )
    ) {
      // Anchor the stem to its nearest meaningful folder: tests/auth/session.test.ts and
      // server/auth/session.ts are one subject; a/utils/date.ts and b/utils/date.ts are two.
      const anchor = dirs
        .slice()
        .reverse()
        .find((s) => !skipped(s));
      return {
        title: human(stem).slice(0, 80),
        key: (anchor ? anchor.toLowerCase() + '/' : '') + stem.toLowerCase(),
      };
    }
    const parent = dirs
      .slice()
      .reverse()
      .find((s) => !skipped(s));
    return {
      title: human(parent || stem).slice(0, 80),
      key: parent ? dirs.join('/') : p,
    };
  }
  const api = { subject, human, stemOf, CHECKS };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FocusTopics = api;
})(typeof window === 'undefined' ? globalThis : window);
