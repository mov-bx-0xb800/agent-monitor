# Documentation

| Task                                                      | Start here                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| Understand the tool and build an extension                | [Project README](../README.md)                                     |
| Connect agents, troubleshoot missing events, or uninstall | [Installation](INSTALLATION.md)                                    |
| Understand stored data, retention and removal             | [Privacy](PRIVACY.md)                                              |
| Know exactly what should happen                           | [Behaviour specification](SPECIFICATION.md)                        |
| Locate code and understand data flow                      | [Architecture](ARCHITECTURE.md)                                    |
| Understand supported and missing events                   | [Coverage](COVERAGE.md)                                            |
| Add an agent integration                                  | [Adapter guide](ADAPTERS.md)                                       |
| Change categories, layout or interaction                  | [Design](DESIGN.md)                                                |
| Understand focus scores and fading colour                 | [Scoring](SCORING.md)                                              |
| Understand direct delivery and provider limits            | [Focus delivery](FOCUS-DELIVERY.md)                                |
| Research possible recommendations (not implemented)       | [Recommendation research](RECOMMENDATIONS-RESEARCH.md)             |
| Run checks or contribute a patch                          | [Contributing](../CONTRIBUTING.md) and [validation](VALIDATION.md) |
| Prepare source or extension artifacts                     | [Release preparation](RELEASING.md)                                |
| Report a security concern                                 | [Security policy](../SECURITY.md)                                  |

The specification describes observable behaviour. Architecture describes the implementation. Validation separates automated evidence from native-host acceptance. If code and a documented contract disagree, fix the discrepancy with a regression case; do not silently broaden a capability claim.

`src/focus-areas.json` is the source of truth for category IDs and descriptions. `src/store.js` defines storage limits. `src/adapters.js` and `src/setup.js` define supported events. Documents explain these contracts; they do not create support for an unimplemented host.
