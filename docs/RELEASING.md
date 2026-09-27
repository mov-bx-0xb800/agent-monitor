# Release preparation

Packaging is local. These commands do not create a remote, upload a file or publish a release.

```sh
npm run check
npm test
npm run format:check
npm run test:ui
npm run package
npm run package:source
```

Outputs are a versioned VSIX and a versioned source ZIP under `dist/`. The source ZIP includes contribution and agent guidance, tests, build scripts and lockfile. It excludes `.git`, installed dependencies, caches, environment files, editor settings and generated evidence. The VSIX includes only the declared extension files. Its README and CHANGELOG links and images point to the public repository (`…/raw/HEAD/` and `…/blob/HEAD/`) so the marketplace page shows them; removing exactly those prefixes must give back the reviewed source. Both paths validate their archive contents before completion.

## Distribution decisions still required

- The public repository is `https://github.com/mov-bx-0xb800/agent-monitor`, with private vulnerability reporting enabled; the security policy points to it.
- The marketplace publisher ID is `wojake` on both Open VSX and the VS Code Marketplace. Create both publisher accounts and accept their agreements before the first publish; the ID is permanent once used.
- Choose a distinct display name before publishing: “Agent Monitor” is already used by other listings.
- Complete native acceptance for the host/platform combinations the release will claim. Publish limitations beside those claims.
- Review the MIT source licence and bundled icon attribution. Keep third-party notices in distributed artifacts.
- Inspect visible screenshot content and the exact source archive. Pattern checks cannot guarantee the absence of every secret or identifying detail.
- Use a commit author identity appropriate for public history. Audit all Git history and tags before publishing; scanning a working tree alone does not scrub old commits.

The package is marked `private` to prevent accidental npm publication. That does not prevent local VSIX packaging and is not a GitHub visibility setting. There is no publication workflow or release credential in the repository.

## Release record

Record the source revision, version, artifact hashes, commands run, native acceptance scope and known gaps. Keep machine-specific paths, user identities, raw hook payloads and conversation identifiers out of the record. Generated artifacts should be rebuilt from the reviewed source; do not circulate stale preview packages.

CI uses read-only repository permissions and performs checks only. Its first hosted run is separate evidence from running the same commands locally. See [GitHub workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use) and [VS Code extension distribution guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
