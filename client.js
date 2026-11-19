/**
 * Browser half of the permanent-delete bundle.
 *
 * Adds one row to the sidebar Session menu that asks for confirmation and then
 * removes the conversation for good through the Host route.
 */

window.__ModuleLoader__.load({
  id: 'dsh-permanent-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'permanent-session-delete'
    const ROUTE = 'api/session.permanentDelete'
    const ICON_KEY = 'permanent-session-delete.trash'
    const DIALOG_ID = 'permanent-session-delete.confirm'

    /** Stable Host error codes to locale keys. */
    const ERROR_KEYS = {
      'not-found': 'error.notFound',
      live: 'error.live',
      'descendant-live': 'error.descendantLive',
      'unexpected-layout': 'error.layout',
      'filesystem-failed': 'error.failed',
      unavailable: 'error.failed',
      'invalid-session-id': 'error.failed',
    }

    const en = {
      'menu.delete': 'Delete permanently',
      'confirm.title': 'Delete this conversation permanently?',
      'confirm.body': 'Its session log is removed from disk immediately and cannot be restored. Its sub-agent sessions are deleted with it; attachments are kept.',
      'confirm.cancel': 'Cancel',
      'confirm.delete': 'Delete permanently',
      'confirm.deleting': 'Deleting…',
      'toast.done': 'Conversation permanently deleted.',
      'toast.doneChildren': 'Conversation and {count} sub-agent session(s) permanently deleted.',
      'toast.failed': 'The conversation could not be deleted.',
      'error.notFound': 'This conversation is already gone.',
      'error.live': 'This conversation is loaded in this app run, so its memory copy cannot be cleared. Restart DeepSeek Harness, then delete it from the sidebar without opening it.',
      'error.descendantLive': 'A sub-agent session of this conversation is still loaded in this app run. Restart DeepSeek Harness, then delete the conversation from the sidebar.',
      'error.layout': 'The session files did not match a known layout, so nothing was deleted.',
      'error.failed': 'The conversation could not be deleted.',
    }

    const zh = {
      'menu.delete': '永久删除',
      'confirm.title': '永久删除这个对话?',
      'confirm.body': '该对话的会话日志会立即从磁盘删除，无法恢复；它的子代理会话会一并删除。附件不会被删除。',
      'confirm.cancel': '取消',
      'confirm.delete': '永久删除',
      'confirm.deleting': '正在删除…',
      'toast.done': '对话已永久删除。',
      'toast.doneChildren': '对话及 {count} 个子代理会话已永久删除。',
      'toast.failed': '对话删除失败。',
      'error.notFound': '该对话已经不存在。',
      'error.live': '该对话在本次运行中已打开，内存副本无法清除。重启 DeepSeek Harness 后，直接从侧边栏删除即可（不要先打开它）。',
      'error.descendantLive': '该对话有子代理会话仍在本次运行中加载，无法清除。重启 DeepSeek Harness 后，从侧边栏删除该对话即可。',
      'error.layout': '会话文件布局无法识别，未删除任何内容。',
      'error.failed': '对话删除失败。',
    }

    /** Scoped dialog styles, mounted with the component. */
    const CSS = `
.pd-scrim{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.36)}
.pd-panel{width:min(440px,100%);max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary)}
.pd-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.pd-body{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.pd-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.pd-status{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.pd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.pd-button{height:32px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background-color 120ms ease}
.pd-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pd-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pd-button:disabled{cursor:default;opacity:.5}
.pd-primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pd-primary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
`

    /** Confirmation state shared by the menu action and the overlay dialog. */
    const confirmation = {
      state: { sessionId: undefined, busy: false, errorKey: undefined },
      listeners: new Set(),
      update(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of [...this.listeners]) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }

    /** A filled trash glyph drawn for this plugin. */
    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M6.4 1.6h3.2l.7 1.2H14v1.3H2V2.8h3.7l.7-1.2Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M3.4 5.2h9.2l-.66 8.36a1.3 1.3 0 0 1-1.3 1.19H5.36a1.3 1.3 0 0 1-1.3-1.19L3.4 5.2Zm2.4 1.5v6.4h1.3V6.7H5.8Zm3.1 0v6.4h1.3V6.7H8.9Z',
          fill: 'currentColor',
        }),
      )
    }

    /**
     * Ask the Host to remove one conversation for good.
     * @param sessionId - target Session.
     * @returns `{ ok: true }` or `{ ok: false, code }` with a stable Host code.
     */
    async function requestDelete(sessionId) {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } catch {
        return { ok: false, code: undefined }
      }
      if (response.ok) {
        let descendants = 0
        try {
          const body = await response.json()
          if (body !== null && typeof body === 'object' && typeof body.descendants === 'number') {
            descendants = body.descendants
          }
        } catch {
          /* the count is optional */
        }
        return { ok: true, descendants }
      }
      let code
      try {
        const body = await response.json()
        code = body && typeof body.error === 'string' ? body.error : undefined
      } catch {
        code = undefined
      }
      return { ok: false, code }
    }

    return {
      inject: ['contextMenus', 'locale', 'slots'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'permanent-session-delete: dictionaries')
          const t = ctx.locale.bind(NS)

          ctx.slots.inject('contextMenu.icon', function* () {
            yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, TrashIcon)
          })

          /** Confirm dialog mounted for the whole plugin lifetime. */
          function ConfirmDialog(props) {
            const translate = typeof props.t === 'function' ? props.t : t
            const [state, setState] = React.useState(confirmation.state)
            const cancelRef = React.useRef(null)
            const panelRef = React.useRef(null)

            React.useEffect(() => confirmation.subscribe(() => setState(confirmation.state)), [])

            React.useEffect(() => {
              if (state.sessionId === undefined) return undefined
              const restore = document.activeElement
              cancelRef.current?.focus()
              const onKeyDown = event => {
                if (event.key === 'Escape') {
                  if (confirmation.state.busy) return
                  event.preventDefault()
                  confirmation.update({ sessionId: undefined, errorKey: undefined })
                  return
                }
                if (event.key !== 'Tab' || panelRef.current === null) return
                const focusable = panelRef.current.querySelectorAll('button:not([disabled])')
                if (focusable.length === 0) return
                const first = focusable[0]
                const last = focusable[focusable.length - 1]
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault()
                  last.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault()
                  first.focus()
                }
              }
              document.addEventListener('keydown', onKeyDown, true)
              return () => {
                document.removeEventListener('keydown', onKeyDown, true)
                if (restore !== null && typeof restore.focus === 'function') restore.focus()
              }
              // Re-focus only when the dialog opens or closes.
              // eslint-disable-next-line react-hooks/exhaustive-deps
            }, [state.sessionId === undefined])

            if (state.sessionId === undefined) return null
            const close = () => {
              if (confirmation.state.busy) return
              confirmation.update({ sessionId: undefined, errorKey: undefined })
            }
            const perform = async () => {
              confirmation.update({ busy: true, errorKey: undefined })
              const result = await requestDelete(state.sessionId)
              if (!result.ok) {
                confirmation.update({ busy: false, errorKey: ERROR_KEYS[result.code] ?? 'error.failed' })
                return
              }
              confirmation.update({ sessionId: undefined, busy: false, errorKey: undefined })
              try {
                await ctx.get('sessions')?.refresh()
              } catch {
                /* the row also goes away on the next list refresh */
              }
              ctx.contextMenus.notify(
                result.descendants > 0
                  ? t('toast.doneChildren', { count: result.descendants })
                  : t('toast.done'),
                true,
              )
            }

            return h(
              React.Fragment,
              null,
              h('style', null, CSS),
              h(
                'div',
                {
                  className: 'pd-scrim',
                  onMouseDown: event => {
                    if (event.target === event.currentTarget) close()
                  },
                },
                h(
                  'div',
                  {
                    className: 'pd-panel',
                    ref: panelRef,
                    role: 'dialog',
                    'aria-modal': 'true',
                    'aria-labelledby': 'pd-title',
                    'aria-describedby': 'pd-body',
                  },
                  h('h2', { id: 'pd-title', className: 'pd-title' }, translate('confirm.title')),
                  h('p', { id: 'pd-body', className: 'pd-body' }, translate('confirm.body')),
                  state.errorKey === undefined
                    ? null
                    : h('p', { className: 'pd-error', role: 'alert' }, translate(state.errorKey)),
                  state.busy
                    ? h('p', { className: 'pd-status', role: 'status' }, translate('confirm.deleting'))
                    : null,
                  h(
                    'div',
                    { className: 'pd-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pd-button',
                        ref: cancelRef,
                        disabled: state.busy,
                        onClick: close,
                      },
                      translate('confirm.cancel'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pd-button pd-primary',
                        disabled: state.busy,
                        onClick: perform,
                      },
                      translate('confirm.delete'),
                    ),
                  ),
                ),
              ),
            )
          }

          ctx.effect(
            () =>
              ctx.contextMenus.register({
                id: 'permanent-session-delete.delete',
                target: 'session',
                order: 900,
                observe: () => [ctx.locale],
                resolve: ({ sessionId }) => [
                  {
                    id: 'delete',
                    label: t('menu.delete'),
                    icon: { key: ICON_KEY },
                    separatorBefore: true,
                    afterContent: true,
                    failureLabel: t('toast.failed'),
                    run: () => {
                      confirmation.update({ sessionId, busy: false, errorKey: undefined })
                    },
                  },
                ],
              }),
            'permanent-session-delete: header action',
          )
          try {
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register({ name: 'shell.overlay', id: DIALOG_ID, locale: NS }, ConfirmDialog))
          } catch (error) {
            // Keep the menu row even if the overlay slot is unavailable.
            console.error('[permanent-session-delete] confirmation dialog unavailable', error)
          }
        } catch (error) {
          console.error('[permanent-session-delete] activation failed', error)
          throw error
        }
      },
    }
  },
})
