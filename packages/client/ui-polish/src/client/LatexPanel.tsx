// LaTeX panel: a `conversation.view` tab giving an Overleaf-style workflow
// over the local TeX distribution: project + file tree on the left, a .tex
// editor in the middle, and a live PDF preview on the right. The host
// compiles with xelatex (Chinese + English) into a temp mirror (bibtex when a
// bibliography is present), so the project tree stays clean; fonts install
// into <project>/fonts/ and TeX packages through tlmgr; the AI button refines
// the file (or a selection) through the LLM service.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the session/workspace slot hooks (useSession/useWorkspaces).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { latexApi, type LatexFile, type LatexModel, type LatexProject } from './latex-client.ts'
import css from './LatexPanel.module.css'

/** Full component props: conversation view share + the ui-polish locale seat. */
export type LatexPanelProps = PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'>

/** The workspace path owning the current session, if any. */
function workspacePathOf(sessionId: string | undefined, items: readonly WorkspaceView[]): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find(item => item.sessionIds.includes(sessionId as never))?.path
}

/**
 * Render the LaTeX panel as a conversation view tab.
 * @param props - composed slot props.
 * @returns the panel.
 */
export function LatexPanel({ useSession, useWorkspaces, t }: LatexPanelProps) {
  const sessionId = useSession(s => s.sessionId)
  const workspaceItems = useWorkspaces(s => s.items)
  const cwd = workspacePathOf(sessionId, workspaceItems)

  const [projects, setProjects] = useState<readonly LatexProject[]>([])
  const [dir, setDir] = useState<string | null>(null)
  const [mainFile, setMainFile] = useState<string | null>(null)
  const [files, setFiles] = useState<readonly LatexFile[]>([])
  const [currentFile, setCurrentFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const [compiling, setCompiling] = useState(false)
  const [compileLog, setCompileLog] = useState<string | null>(null)
  const [compileOk, setCompileOk] = useState(false)
  const [pdfTick, setPdfTick] = useState(0)
  const [autoCompile, setAutoCompile] = useState<boolean>(() => {
    try { return (window.localStorage.getItem('dsh-latex-auto') ?? '1') === '1' } catch { return true }
  })
  const [notice, setNotice] = useState<string | null>(null)
  const [fontModalOpen, setFontModalOpen] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiSelection, setAiSelection] = useState<string | undefined>(undefined)

  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const gutterRef = useRef<HTMLPreElement | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  // One entry per logical line: the editor does not wrap, so the gutter stays
  // aligned with the text beside it.
  const lineCount = content.length === 0 ? 1 : content.split('\n').length
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n'),
    [lineCount],
  )

  const flash = useCallback((text: string) => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => { setNotice(null) }, 2500)
  }, [])

  const openFile = useCallback(async (path: string, projectDir: string) => {
    try {
      const { content: text } = await latexApi.read(cwd as string, projectDir, path)
      setCurrentFile(path)
      setContent(text)
      setDirty(false)
      setFileError(null)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }, [cwd])

  const reloadFiles = useCallback(async (projectDir: string) => {
    const { files: tree } = await latexApi.list(cwd as string, projectDir)
    setFiles(tree)
  }, [cwd])

  const selectProject = useCallback(async (projectDir: string) => {
    setDir(projectDir)
    setMainFile(null)
    setCompileLog(null)
    setCompileOk(false)
    try {
      const { files: tree } = await latexApi.list(cwd as string, projectDir)
      setFiles(tree)
      const main = tree.find(f => !f.dir && f.path.toLowerCase().endsWith('.tex'))
      if (main !== undefined) {
        setMainFile(main.path)
        await openFile(main.path, projectDir)
      }
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }, [cwd, openFile])

  // Discover projects when the workspace changes; the first one is the
  // initial selection (the workspace root '.' stays selectable when none
  // contains .tex files).
  useEffect(() => {
    if (cwd === undefined) return
    let live = true
    void latexApi.projects(cwd)
      .then((result) => {
        if (!live) return
        setProjects(result.projects)
        setDir((prev) => {
          if (prev === null && result.projects.length > 0) {
            const first = result.projects[0] as LatexProject
            void selectProject(first.path)
            return first.path
          }
          return prev
        })
      })
      .catch((error: unknown) => { if (live) setFileError(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [cwd])

  const compileNow = useCallback(async () => {
    if (cwd === undefined || dir === null || mainFile === null) return
    setCompiling(true)
    setCompileLog(null)
    setCompileOk(false)
    try {
      const result = await latexApi.compile(cwd, dir, mainFile)
      if (result.ok) {
        setCompileOk(true)
        setPdfTick(v => v + 1)
        const supplied = result.supplied?.length ?? 0
        flash(supplied > 0 ? t('latex.suppliedGraphics', { n: supplied }) : t('latex.compiled'))
      } else {
        setCompileLog(result.log ?? '—')
      }
    } catch (error) {
      setCompileLog(error instanceof Error ? error.message : String(error))
    } finally {
      setCompiling(false)
    }
  }, [cwd, dir, mainFile, flash, t])

  const save = useCallback(async () => {
    if (cwd === undefined || dir === null || currentFile === null || !dirty) return
    try {
      await latexApi.write(cwd, dir, currentFile, content)
      setDirty(false)
      if (autoCompile) {
        void compileNow()
      }
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }, [cwd, dir, currentFile, content, dirty, autoCompile, compileNow])

  const newFile = useCallback(async () => {
    if (dir === null) return
    const name = window.prompt(t('latex.newFilePrompt'), 'main.tex')
    if (name === null || name.trim().length === 0) return
    const rel = name.trim()
    try {
      await latexApi.write(cwd as string, dir, rel, '')
      await reloadFiles(dir)
      await openFile(rel, dir)
      setMainFile(rel)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }, [dir, cwd, reloadFiles, openFile, t])

  const toggleAuto = useCallback(() => {
    setAutoCompile((v) => {
      try {
        window.localStorage.setItem('dsh-latex-auto', v ? '0' : '1')
      } catch {
        // Storage unavailable: the toggle still applies for this session.
      }
      return !v
    })
  }, [])

  const cleanProject = useCallback(async () => {
    if (dir === null) return
    try {
      const { removed } = await latexApi.clean(cwd as string, dir)
      flash(t('latex.cleaned', { n: removed }))
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }, [dir, cwd, flash, t])

  const openAi = useCallback(() => {
    const editor = editorRef.current
    let selection: string | undefined
    if (editor !== null && editor.selectionStart !== editor.selectionEnd) {
      selection = editor.value.slice(editor.selectionStart, editor.selectionEnd)
    }
    setAiSelection(selection)
    setAiModalOpen(true)
  }, [])

  const applyAiResult = useCallback((text: string) => {
    const editor = editorRef.current
    if (aiSelection !== undefined && editor !== null) {
      const start = editor.selectionStart
      const end = editor.selectionEnd
      if (start < end) {
        setContent(editor.value.slice(0, start) + text + editor.value.slice(end))
        setDirty(true)
        setAiModalOpen(false)
        return
      }
    }
    setContent(text)
    setDirty(true)
    setAiModalOpen(false)
  }, [aiSelection])

  if (cwd === undefined) {
    return <div className={css.empty}>{t('latex.noWorkspace')}</div>
  }

  const projectOptions = projects.length > 0
    ? projects
    : [{ path: '.', name: '.', mainFiles: [] }]

  return (
    <div className={css.view}>
      <header className={css.toolbar}>
        <select
          className={css.select}
          value={dir ?? '.'}
          onChange={e => void selectProject(e.target.value)}
          title={t('latex.project')}
        >
          {projectOptions.map(p => (
            <option key={p.path} value={p.path}>{p.name === '.' ? t('latex.rootProject') : p.name}</option>
          ))}
        </select>
        <select
          className={css.select}
          value={mainFile ?? ''}
          disabled={files.length === 0}
          onChange={(e) => { setMainFile(e.target.value) }}
          title={t('latex.mainFile')}
        >
          {files.filter(f => !f.dir && f.path.toLowerCase().endsWith('.tex')).map(f => (
            <option key={f.path} value={f.path}>{f.path}</option>
          ))}
        </select>
        <button className={css.btn} disabled={compiling || mainFile === null} onClick={() => void compileNow()}>
          {compiling ? t('latex.compiling') : t('latex.compile')}
        </button>
        <label className={css.autoToggle}>
          <input type="checkbox" checked={autoCompile} onChange={toggleAuto} />
          {t('latex.auto')}
        </label>
        <button className={css.btn} onClick={() => void cleanProject()}>{t('latex.clean')}</button>
        <button className={css.btn} onClick={() => void newFile()}>{t('latex.newFile')}</button>
        <button className={css.btn} onClick={() => { setFontModalOpen(true) }}>{t('latex.fonts')}</button>
        <button className={css.btn} disabled={currentFile === null} onClick={openAi}>✦ {t('latex.ai')}</button>
      </header>

      <div className={css.body}>
        <aside className={css.treePane}>
          <div className={css.treeHead}>
            <span>{t('latex.files')}</span>
          </div>
          {files.length === 0
            ? <div className={css.empty}>{t('latex.noFiles')}</div>
            : (
              <ul className={css.tree}>
                {files.map(f => (
                  <li
                    key={f.path}
                    className={f.dir ? css.treeDir : css.treeFile}
                    {...(f.dir ? {} : {
                      onClick: () => void openFile(f.path, dir ?? '.'),
                      'data-current': currentFile === f.path ? '1' : undefined,
                    })}
                    title={f.path}
                  >
                    {f.dir ? `${f.path}/` : f.path}
                  </li>
                ))}
              </ul>
            )}
        </aside>

        <main className={css.editorPane}>
          {currentFile === null
            ? <div className={css.empty}>{t('latex.pickFile')}</div>
            : (
              <>
                <div className={css.editorHead}>
                  <span className={css.fileName}>{currentFile}</span>
                  {dirty && <span className={css.dirtyDot}>●</span>}
                  <button
                    className={css.btn}
                    disabled={!dirty}
                    onClick={() => void save()}
                    title={t('latex.saveHint')}
                  >
                    {t('latex.save')}
                  </button>
                </div>
                <div className={css.editorBox}>
                  <pre ref={gutterRef} className={css.gutter} aria-hidden="true">{lineNumbers}</pre>
                  <textarea
                    ref={editorRef}
                    className={css.editor}
                    value={content}
                    spellCheck={false}
                    // No wrapping: a logical line is one visual line, which is what
                    // keeps the gutter numbers beside their lines.
                    wrap="off"
                    onScroll={(e) => {
                      const gutter = gutterRef.current
                      if (gutter !== null) gutter.scrollTop = e.currentTarget.scrollTop
                    }}
                    onChange={(e) => { setContent(e.target.value); setDirty(true) }}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                        e.preventDefault()
                        void save()
                      }
                    }}
                    onKeyUp={(e) => {
                      // Tab inserts two spaces instead of moving focus.
                      if (e.key === 'Tab') {
                        e.preventDefault()
                        const el = e.currentTarget
                        const start = el.selectionStart
                        const end = el.selectionEnd
                        setContent(content.slice(0, start) + '  ' + content.slice(end))
                        requestAnimationFrame(() => {
                          el.selectionStart = el.selectionEnd = start + 2
                        })
                      }
                    }}
                  />
                </div>
              </>
            )}
          {fileError !== null && <div className={css.error}>{fileError}</div>}
          {notice !== null && <div className={css.toast}>{notice}</div>}
        </main>

        <section className={css.pdfPane}>
          <div className={css.pdfHead}>
            <span>{t('latex.preview')}</span>
            {compileOk && pdfTick > 0 && (
              <button
                className={css.btn}
                onClick={() => { setPdfTick(v => v + 1) }}
                title={t('latex.reload')}
              >
                ⟳
              </button>
            )}
          </div>
          {compileOk && pdfTick > 0 && mainFile !== null
            ? <iframe className={css.pdf} title={t('latex.preview')} src={latexApi.pdfUrl(cwd, dir ?? '.', mainFile, pdfTick)} />
            : (
              <div className={css.empty}>
                {compileLog !== null
                  ? <pre className={css.log}>{compileLog}</pre>
                  : t('latex.noPdf')}
              </div>
            )}
        </section>
      </div>

      {fontModalOpen && dir !== null && (
        <FontModal
          cwd={cwd}
          dir={dir}
          onClose={() => { setFontModalOpen(false) }}
          t={t}
        />
      )}

      {aiModalOpen && currentFile !== null && dir !== null && (
        <AiModal
          cwd={cwd}
          dir={dir}
          path={currentFile}
          selection={aiSelection}
          onResult={applyAiResult}
          onClose={() => { setAiModalOpen(false) }}
          t={t}
        />
      )}
    </div>
  )
}

// --- Modals ------------------------------------------------------------------

interface FontModalProps {
  cwd: string
  dir: string
  onClose: () => void
  t: TranslateNS<'ui-polish'>
}

/** Font management: project fonts, TTF/OTF upload, tlmgr package install. */
function FontModal({ cwd, dir, onClose, t }: FontModalProps) {
  const [fonts, setFonts] = useState<string[]>([])
  const [packages, setPackages] = useState<{ ctex: boolean; xecjk: boolean; fandol: boolean } | null>(null)
  const [pkgName, setPkgName] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(() => {
    void latexApi.fontList(cwd, dir)
      .then((status) => {
        setFonts([...status.fonts])
        setPackages(status.packages)
      })
      .catch((error: unknown) => { setLog(error instanceof Error ? error.message : String(error)) })
  }, [cwd, dir])

  useEffect(() => { load() }, [load])

  const upload = (file: File): void => {
    setBusy(true)
    setLog(null)
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        if (typeof reader.result !== 'string') throw new Error('latex panel: the font file could not be read')
        const dataUrl = reader.result
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        await latexApi.fontInstall(cwd, dir, file.name, base64)
        load()
      } catch (error) {
        setLog(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    }
    reader.readAsDataURL(file)
  }

  const installPackage = async (): Promise<void> => {
    if (pkgName.trim().length === 0) return
    setBusy(true)
    setLog(null)
    try {
      const { log: out } = await latexApi.fontInstallPackage(cwd, dir, pkgName.trim())
      setLog(out)
      setPkgName('')
      load()
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modal} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.modalTitle}>{t('latex.fontsTitle')}</div>
        <div className={css.fontSection}>
          <div className={css.label}>{t('latex.fontsInstalled')}</div>
          {fonts.length === 0
            ? <div className={css.empty}>{t('latex.noFonts')}</div>
            : <ul className={css.fontList}>{fonts.map(f => <li key={f}>{f}</li>)}</ul>}
          <input
            ref={fileInputRef}
            type="file"
            accept=".ttf,.otf,.otc,.ttc"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file !== undefined) upload(file)
              e.target.value = ''
            }}
          />
          <button className={css.btn} disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {t('latex.fontUpload')}
          </button>
          <div className={css.fontHint}>{t('latex.fontHint')}</div>
        </div>
        <div className={css.fontSection}>
          <div className={css.label}>{t('latex.packages')}</div>
          {packages !== null && (
            <div className={css.pkgRow}>
              <span {...(packages.ctex ? { className: css.pkgOk } : { className: css.pkgNo })}>{t('latex.pkgCtex')}</span>
              <span {...(packages.xecjk ? { className: css.pkgOk } : { className: css.pkgNo })}>{t('latex.pkgXecjk')}</span>
              <span {...(packages.fandol ? { className: css.pkgOk } : { className: css.pkgNo })}>{t('latex.pkgFandol')}</span>
            </div>
          )}
          <div className={css.pkgInputRow}>
            <input
              className={css.input}
              value={pkgName}
              placeholder={t('latex.pkgPlaceholder')}
              onChange={(e) => { setPkgName(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void installPackage() }}
            />
            <button className={css.btn} disabled={busy || pkgName.trim().length === 0} onClick={() => void installPackage()}>
              {busy ? '…' : t('latex.pkgInstall')}
            </button>
          </div>
        </div>
        {log !== null && <pre className={css.log}>{log}</pre>}
        <div className={css.modalActions}>
          <button className={css.btn} onClick={onClose}>{t('latex.close')}</button>
        </div>
      </div>
    </div>
  )
}

interface AiModalProps {
  cwd: string
  dir: string
  path: string
  selection: string | undefined
  onResult: (text: string) => void
  onClose: () => void
  t: TranslateNS<'ui-polish'>
}

/** The AI writing assistant over the current file (or its selection). */
/** One rendered turn of the writing conversation. */
interface AiTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

function AiModal({ cwd, dir, path, selection, onResult, onClose, t }: AiModalProps) {
  const [instruction, setInstruction] = useState('')
  const [turns, setTurns] = useState<readonly AiTurn[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<readonly LatexModel[]>([])
  const [model, setModel] = useState<string>(() => {
    try { return window.localStorage.getItem('dsh-latex-ai-model') ?? '' } catch { return '' }
  })
  const tokenRef = useRef('')
  const logRef = useRef<HTMLDivElement | null>(null)

  // The catalog is fetched when the modal opens (topology, not file state).
  useEffect(() => {
    let live = true
    void latexApi.models()
      .then((result) => { if (live) setModels(result.models) })
      .catch(() => { if (live) setModels([]) })
    return () => { live = false }
  }, [])

  // Keep the newest text in view while deltas arrive.
  useEffect(() => {
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [turns])

  const pickModel = (next: string): void => {
    setModel(next)
    try {
      if (next === '') window.localStorage.removeItem('dsh-latex-ai-model')
      else window.localStorage.setItem('dsh-latex-ai-model', next)
    } catch {
      // Storage unavailable: the choice still applies for this session.
    }
  }

  const replaceLast = (text: string): void => {
    setTurns(current => current.map((turn, index) => (
      index === current.length - 1 ? { role: 'assistant', text } : turn
    )))
  }

  /** Send one turn; the log keeps both sides so a follow-up can refine the answer. */
  const run = async (): Promise<void> => {
    const text = instruction.trim()
    if (text.length === 0 || running) return
    setRunning(true)
    setError(null)
    setInstruction('')
    const history = turns
    const token = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`
    tokenRef.current = token
    setTurns([...history, { role: 'user', text }, { role: 'assistant', text: '' }])
    try {
      const result = await latexApi.ai(cwd, dir, path, selection, text, history, token, (delta) => {
        setTurns(current => current.map((turn, index) => (
          index === current.length - 1 ? { role: 'assistant', text: turn.text + delta } : turn
        )))
      }, model === '' ? undefined : model)
      replaceLast(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTurns((current) => {
        const last = current[current.length - 1]
        // A turn that failed before producing text leaves no placeholder behind.
        return last !== undefined && last.role === 'assistant' && last.text.length === 0
          ? current.slice(0, -1)
          : current
      })
    } finally {
      setRunning(false)
    }
  }

  const stop = (): void => { void latexApi.aiCancel(tokenRef.current) }
  const latest = [...turns].reverse().find(turn => turn.role === 'assistant' && turn.text.length > 0)?.text

  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modal} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.modalTitle}>
          ✦ {t('latex.aiTitle')}
          {selection !== undefined && <span className={css.aiSelectionTag}>{t('latex.aiSelectionMode')}</span>}
        </div>
        <select
          className={css.select}
          value={model}
          title={t('latex.aiModel')}
          onChange={(e) => { pickModel(e.target.value) }}
        >
          <option value="">{t('latex.aiModelDefault')}</option>
          {models.map(option => (
            <option key={`${option.provider}/${option.model}`} value={`${option.provider}/${option.model}`}>
              {`${option.name} (${option.provider})`}
            </option>
          ))}
        </select>
        {turns.length > 0 && (
          <div ref={logRef} className={css.aiLog} data-ai-log="">
            {turns.map((turn, index) => (
              <div
                key={index}
                className={turn.role === 'user' ? css.aiTurnUser : css.aiTurnAssistant}
                data-ai-turn={turn.role}
              >
                {turn.text.length > 0 ? turn.text : t('latex.aiRunning')}
              </div>
            ))}
          </div>
        )}
        {error !== null && <div className={css.error}>{error}</div>}
        <textarea
          className={css.aiInput}
          value={instruction}
          placeholder={t('latex.aiPlaceholder')}
          rows={3}
          onChange={(e) => { setInstruction(e.target.value) }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
        />
        <div className={css.modalActions}>
          <button className={css.btn} onClick={onClose}>{t('latex.close')}</button>
          <button
            className={css.btn}
            disabled={latest === undefined}
            onClick={() => { if (latest !== undefined) onResult(latest) }}
          >
            {t('latex.aiApply')}
          </button>
          {running
            ? <button className={css.btn} onClick={stop}>{t('latex.aiStop')}</button>
            : (
              <button className={css.btn} disabled={instruction.trim().length === 0} onClick={() => void run()}>
                {t('latex.aiRun')}
              </button>
            )}
        </div>
      </div>
    </div>
  )
}
