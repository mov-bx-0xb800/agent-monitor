'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
function html(webview, { surface = 'view' } = {}) {
  const nonce = crypto.randomBytes(18).toString('hex'),
    media = path.join(__dirname, '..', 'media');
  const css = fs.readFileSync(path.join(media, 'view.css'), 'utf8');
  const js =
    fs.readFileSync(path.join(__dirname, 'attention.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(media, 'icons.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(media, 'providers.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(media, 'model.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(media, 'view.js'), 'utf8');
  return /* HTML */ `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Agent Monitor</title>
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
        />
        <style nonce="${nonce}">
          ${css}
        </style>
      </head>
      <body data-surface="${surface === 'editor' ? 'editor' : 'view'}">
        <h1 class="sr-only">Agent Monitor</h1>
        <header class="monitor-toolbar">
          <div class="utility-bar">
            <button
              id="open-editor"
              data-action="open-editor"
              class="window-button"
              title="Open Agent Monitor in the main editor area"
            >
              <span data-icon="arrow-up"></span>Main Window
            </button>
            <div class="utility-actions">
              <button
                id="agents-open"
                data-action="setup"
                class="icon-button"
                aria-label="Agent setup"
                title="Agent setup"
              >
                <span data-icon="plug"></span></button
              ><button
                id="pause"
                data-action="pause"
                class="icon-button"
                aria-label="Pause collection"
                title="Pause collection"
              >
                <span data-icon="debug-pause"></span></button
              ><button
                id="help-toggle"
                class="icon-button"
                aria-label="How activity is tracked"
                title="How activity is tracked"
                aria-expanded="false"
                aria-controls="help-panel"
              >
                <span data-icon="info"></span></button
              ><button
                data-action="settings"
                class="icon-button"
                aria-label="Agent Monitor settings"
                title="Agent Monitor settings"
              >
                <span data-icon="gear"></span>
              </button>
            </div>
          </div>
          <aside id="help-panel" aria-label="How activity is tracked" hidden>
            <dl>
              <dt>Focus score</dt>
              <dd>
                Recent observed attention to an area, from 0 to 100. Sustained work raises it; time
                and work elsewhere lower it. It does not measure quality or completion.
              </dd>
              <dt>Bars and colour</dt>
              <dd>
                A bar’s length is the score. Its colour fades as the evidence ages, including after
                a turn ends.
              </dd>
              <dt>Focus here</dt>
              <dd>
                Sends one chat a request to give an area attention. Where the agent cannot take it
                immediately, it waits for that chat’s next supported event and expires after an
                hour. “Sent!” means the agent's hook received it; the agent has not confirmed it.
              </dd>
              <dt>Images</dt>
              <dd>
                A red count marks images agents used since you last looked. Up to 20 images (64 MiB,
                24 million pixels) are kept until you dismiss them.
              </dd>
              <dt>Coverage</dt>
              <dd>
                Local Codex, Claude Code and Cursor hooks only. Hosted tools and other runtimes are
                not observed. Transcripts and reasoning are never collected.
              </dd>
            </dl>
          </aside>
        </header>
        <nav role="tablist" aria-label="Monitor views">
          <button role="tab" id="tab-focus" data-tab="focus" aria-controls="panel-focus">
            <span data-icon="target"></span>Focus</button
          ><button role="tab" id="tab-images" data-tab="images" aria-controls="panel-images">
            <span data-icon="file-media"></span>Images
            <span id="image-unseen" class="notify-badge" hidden></span>
          </button>
        </nav>
        <main>
          <div id="setup-warning" class="setup-warning" hidden>
            <span data-icon="warning"></span>
            <div>
              <strong id="setup-warning-title">Agent setup required</strong>
              <p id="setup-warning-note"></p>
            </div>
            <div class="setup-warning-actions">
              <button id="setup-open" data-action="setup">Set up</button
              ><button id="setup-ignore" class="warning-link" hidden></button>
            </div>
          </div>
          <div id="notice" class="message" hidden>
            <span data-icon="info"></span><span id="notice-text" role="status"></span
            ><button
              data-action="clear-notice"
              class="icon-button"
              aria-label="Dismiss notification"
              title="Dismiss notification"
            >
              <span data-icon="close"></span>
            </button>
          </div>
          <div id="pause-message" class="message paused" hidden>
            <span data-icon="debug-pause"></span
            ><span>Collection paused. New activity and requests wait until you resume.</span
            ><button data-action="pause" class="secondary">Resume</button>
          </div>
          <section id="chat-picker" aria-labelledby="chat-picker-title">
            <div class="section-title">
              <div class="title-group">
                <h2 id="chat-picker-title">Chats</h2>
                <span id="summary" class="caption"></span>
              </div>
              <div class="chat-picker-controls">
                <button
                  id="chats-previous"
                  class="icon-button"
                  aria-label="Scroll chats left"
                  title="Scroll chats left"
                >
                  <span data-icon="chevron-left"></span>
                </button>
                <button
                  id="chats-next"
                  class="icon-button"
                  aria-label="Scroll chats right"
                  title="Scroll chats right"
                >
                  <span data-icon="chevron-right"></span>
                </button>
              </div>
            </div>
            <div id="chat-strip" role="group" aria-label="Chat selection"></div>
          </section>
          <section id="panel-focus" role="tabpanel" tabindex="0" aria-labelledby="tab-focus">
            <div id="chat-summary"></div>
            <div id="focus-content">
              <div id="stakes" class="stakes"></div>
              <div class="section-title">
                <h2>Focused areas</h2>
                <button id="choose-areas" class="text-button">Choose areas</button>
              </div>
              <div id="groups" data-zone="primary"></div>
              <div id="detail" hidden></div>
              <details id="more-areas" data-zone="extra">
                <summary>
                  <span data-icon="chevron-right"></span
                  ><span id="more-areas-label">More areas</span>
                </summary>
                <div id="extra-groups"></div>
              </details>
            </div>
          </section>
          <section
            id="panel-images"
            role="tabpanel"
            tabindex="0"
            aria-labelledby="tab-images"
            hidden
          >
            <div class="section-title" id="image-title">
              <div class="title-group">
                <h2 id="image-heading">Images</h2>
                <span id="image-position" class="caption"></span>
              </div>
              <button id="follow" class="toggle" aria-pressed="true">
                <span class="check-box" aria-hidden="true"></span>Follow latest
              </button>
            </div>
            <div id="thumbnails" role="group" aria-label="Image history"></div>
            <div id="image-stage">
              <article id="image-frame" class="image-frame" hidden>
                <div class="image-box">
                  <div id="image-view" class="image-view"></div>
                  <button
                    id="previous"
                    class="image-nav previous"
                    aria-label="Previous image"
                    title="Previous image"
                  >
                    <span data-icon="chevron-left"></span></button
                  ><button
                    id="next"
                    class="image-nav next"
                    aria-label="Next image"
                    title="Next image"
                  >
                    <span data-icon="chevron-right"></span>
                  </button>
                </div>
                <div class="image-meta">
                  <div class="image-label">
                    <span id="image-name"></span
                    ><button
                      id="image-open"
                      class="icon-button"
                      aria-label="Open image in editor"
                      title="Open image in editor"
                    >
                      <span data-icon="go-to-file"></span></button
                    ><button
                      id="image-dismiss"
                      class="icon-button"
                      aria-label="Dismiss image"
                      title="Dismiss image"
                    >
                      <span data-icon="close"></span>
                    </button>
                  </div>
                  <p id="image-state" class="image-state" hidden></p>
                  <p id="image-by" class="image-by"></p>
                  <p id="image-quality" class="image-quality" hidden></p>
                </div>
              </article>
              <div id="image-empty"></div>
            </div>
          </section>
        </main>

        <dialog id="setup-dialog" aria-labelledby="setup-title">
          <div class="dialog-heading">
            <h2 id="setup-title">Agent setup</h2>
            <button
              id="setup-close"
              class="icon-button"
              aria-label="Close agent setup"
              title="Close agent setup"
            >
              <span data-icon="close"></span>
            </button>
          </div>
          <p id="setup-feedback" role="status" class="setup-feedback" hidden></p>
          <div id="connections"></div>
          <div class="dialog-footer">
            <span class="caption">Status reflects tool events from this workspace.</span
            ><button data-action="refresh" class="text-button">Check again</button>
          </div>
        </dialog>
        <script nonce="${nonce}">
          ${js};
        </script>
      </body>
    </html>`;
}
module.exports = { html };
