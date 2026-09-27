'use strict';

// This is a distribution hygiene check, not a complete secret or PII detector.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yauzl = require('yauzl');

const ROOT_FILES = new Set([
  '.gitignore',
  '.editorconfig',
  '.prettierrc.json',
  '.prettierignore',
  'AGENTS.md',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
]);
const SOURCE_DIRS = new Set(['src', 'media', 'docs', 'scripts', 'test', '.github']);
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.evidence', 'coverage']);
const IMAGE_FILES = new Set([
  'media/icon.png',
  'docs/images/chat.png',
  'docs/images/focus.png',
  'docs/images/images.png',
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

function sourceFiles(root) {
  const files = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (!relative && EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw Error(name + ': symlinks are not distributable');
      if (!relative && !ROOT_FILES.has(entry.name) && !SOURCE_DIRS.has(entry.name)) {
        throw Error(name + ': undeclared source entry');
      }
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push(name);
      else throw Error(name + ': unsupported filesystem entry');
      if (files.length > 300) throw Error('Source inventory exceeds review limit');
    }
  }
  walk();
  return files.sort();
}

function sensitiveRules(text, terms = []) {
  const rules = [];
  // Deliberately narrow patterns avoid treating code variable names as credentials.
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text))
    rules.push('private key');
  if (
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}|AKIA[0-9A-Z]{16})/.test(
      text,
    )
  )
    rules.push('credential-like token');
  if (/https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(text)) rules.push('credential-bearing URL');
  const canonical = text.replaceAll('\\\\', '\\');
  const homes = [
    ...canonical.matchAll(/(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)([^\s/\\"'`<>]+)/g),
  ];
  if (homes.some((match) => !['demo', 'example'].includes(match[1])))
    rules.push('identifying home path');
  const home = os.homedir();
  if (home.length > 3 && (text.includes(home) || canonical.includes(home)))
    rules.push('current home directory');
  if (terms.some((term) => term.length > 2 && text.toLowerCase().includes(term.toLowerCase())))
    rules.push('private term');
  return [...new Set(rules)];
}

function inspectPNG(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw Error('invalid PNG signature');
  let offset = 8,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw Error('truncated PNG');
    // Distributed PNGs need no text, EXIF, author, software or arbitrary metadata chunks.
    if (!['IHDR', 'IDAT', 'IEND'].includes(kind)) throw Error('unreviewed PNG metadata: ' + kind);
    offset += length + 12;
    if (kind === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) throw Error('invalid PNG ending');
}

function checkFile(name, bytes, terms = []) {
  if (bytes.length > MAX_FILE_BYTES) throw Error(name + ': exceeds review size limit');
  if (
    /(^|\/)(?:\.env(?:\..*)?|\.npmrc|settings\.json|hooks\.json|state\.json|steering\.json|health-.*\.json)$|\.(?:log|pem|key|p12|pfx|vsix|zip|agent-monitor-backup|pending)$/i.test(
      name,
    )
  )
    throw Error(name + ': private or generated file');
  if (IMAGE_FILES.has(name)) {
    inspectPNG(bytes);
    return;
  }
  if (
    name !== 'src/claude-wake.sh' &&
    !ROOT_FILES.has(name) &&
    !/\.(?:md|txt|js|cjs|json|css|svg|ya?ml)$/.test(name)
  )
    throw Error(name + ': unreviewed file type');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const issues = sensitiveRules(text, terms);
  if (issues.length) throw Error(name + ': ' + issues.join(', '));
}

function checkLinks(name, text, files) {
  if (!name.endsWith('.md')) return;
  const targets = [...text.matchAll(/\]\(([^)]+)\)|\bsrc="([^"]+)"/g)].map((m) =>
    (m[1] || m[2]).replace(/^<|>$/g, ''),
  );
  for (const target of targets) {
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const file = decodeURIComponent(target.split('#')[0]);
    if (!file) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), file));
    if (!files.has(resolved)) throw Error(name + ': broken local link to ' + target);
  }
}

function checkRepository(root, terms = privateTerms()) {
  const files = sourceFiles(root),
    known = new Set(files);
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(root, name));
    checkFile(name, bytes, terms);
    checkLinks(name, bytes.toString('utf8'), known);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  if (manifest.version !== lock.version || manifest.version !== lock.packages[''].version)
    throw Error('Package versions disagree');
  if (Object.keys(manifest.dependencies || {}).length)
    throw Error('Runtime dependencies require an explicit architecture change');
  if (manifest.private !== true) throw Error('npm publication guard is missing');
  return files;
}

function privateTerms() {
  // Optional values stay in the invoking environment and are never written to artifacts.
  return (process.env.AGENT_MONITOR_PRIVATE_TERMS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// vsce points relative README and CHANGELOG links at the public repository. Removing exactly
// those prefixes must give back the reviewed source; any other difference is rejected.
function repositoryPrefixes(manifest) {
  const url =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url || '');
  return match ? ['raw', 'blob'].map((kind) => `https://github.com/${match[1]}/${kind}/HEAD/`) : [];
}
function sameAsSource(source, bytes, expected, prefixes) {
  if (bytes.equals(expected)) return true;
  if (!['README.md', 'CHANGELOG.md'].includes(source) || !prefixes.length) return false;
  const original = expected.toString('utf8');
  if (prefixes.some((prefix) => original.includes(prefix))) return false;
  let text = bytes.toString('utf8');
  for (const prefix of prefixes) text = text.split(prefix).join('');
  return text === original;
}

function verifyArchive(file, kind, root, terms = privateTerms()) {
  const allowed = new Set(checkRepository(root, terms));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))),
    version = manifest.version,
    prefixes = kind === 'vsix' ? repositoryPrefixes(manifest) : [];
  const sourcePrefix = `agent-monitor-${version}/`;
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) return reject(error);
      let total = 0;
      const seen = new Set();
      const included = new Set();
      const fail = (error) => {
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        try {
          const name = entry.fileName;
          if (seen.has(name) || name.startsWith('/') || name.split('/').includes('..'))
            throw Error('Invalid archive entry');
          seen.add(name);
          total += entry.uncompressedSize;
          if (total > MAX_ARCHIVE_BYTES || entry.uncompressedSize > MAX_FILE_BYTES)
            throw Error('Archive exceeds review limits');
          let source;
          if (kind === 'source') {
            if (!name.startsWith(sourcePrefix)) throw Error('Unexpected source archive prefix');
            source = name.slice(sourcePrefix.length);
          } else if (['[Content_Types].xml', 'extension.vsixmanifest'].includes(name))
            source = null;
          else {
            if (!name.startsWith('extension/')) throw Error('Unexpected VSIX entry');
            source = name.slice(10);
            source =
              {
                'readme.md': 'README.md',
                'changelog.md': 'CHANGELOG.md',
                'LICENSE.txt': 'LICENSE',
              }[source] || source;
            if (
              !/^(src\/|media\/|docs\/|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$|SECURITY\.md$|CONTRIBUTING\.md$|AGENTS\.md$)/.test(
                source,
              )
            )
              throw Error('Unexpected VSIX source file');
          }
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
            throw Error('Archive symlink is not allowed');
          if (source) included.add(source);
          if (source && !allowed.has(source)) throw Error('Archive contains undeclared file');
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error);
            const chunks = [];
            let size = 0;
            stream.on('error', fail);
            stream.on('data', (chunk) => {
              size += chunk.length;
              if (size > MAX_FILE_BYTES) {
                stream.destroy();
                fail(Error('Archive entry exceeds limit'));
              } else chunks.push(chunk);
            });
            stream.on('end', () => {
              try {
                const bytes = Buffer.concat(chunks);
                if (source) {
                  checkFile(source, bytes, terms);
                  if (
                    !sameAsSource(source, bytes, fs.readFileSync(path.join(root, source)), prefixes)
                  )
                    throw Error('Archive differs from reviewed source: ' + source);
                } else if (sensitiveRules(bytes.toString('utf8'), terms).length)
                  throw Error('Sensitive archive metadata');
                zip.readEntry();
              } catch (error) {
                fail(error);
              }
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.on('end', () => {
        try {
          for (const source of included)
            checkLinks(source, fs.readFileSync(path.join(root, source), 'utf8'), included);
        } catch (error) {
          return reject(error);
        }
        if (kind === 'source' && seen.size !== allowed.size)
          return reject(Error('Incomplete source archive'));
        if (kind !== 'source' && !seen.has('extension/package.json'))
          return reject(Error('Missing extension manifest'));
        resolve({ files: seen.size, bytes: total });
      });
      zip.readEntry();
    });
  });
}

if (require.main === module) {
  try {
    console.log(
      `Repository checks passed: ${checkRepository(path.resolve(__dirname, '..')).length} source files.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = {
  sourceFiles,
  sensitiveRules,
  inspectPNG,
  checkFile,
  checkLinks,
  checkRepository,
  repositoryPrefixes,
  sameAsSource,
  verifyArchive,
};
