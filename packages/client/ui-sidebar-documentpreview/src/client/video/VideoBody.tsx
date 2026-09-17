/** Complete video bytes played in place, contained by the pane's width. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import type {} from './locales.ts'
import css from './VideoBody.module.css'

const VIDEO_MEDIA_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
} as const

type VideoMediaType = typeof VIDEO_MEDIA_TYPES[keyof typeof VIDEO_MEDIA_TYPES]

/** Standard document props plus the video renderer's dictionary. */
export type VideoBodyProps = DocumentPreviewProps & PropsLocale<'sidebarVideo'>

type VideoSource =
  | { readonly kind: 'ready'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: VideoMediaType; readonly url: string }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: VideoMediaType }

/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the video media type, or undefined for an unregistered suffix.
 */
export function videoMediaType(path: string): VideoMediaType | undefined {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const extension = name.slice(name.lastIndexOf('.') + 1) as keyof typeof VIDEO_MEDIA_TYPES
  return VIDEO_MEDIA_TYPES[extension]
}

/**
 * Present complete video bytes with the browser's own player controls.
 *
 * The element is `preload="metadata"` because the bytes are already in memory
 * as a Blob URL: the media is local, but only the poster frame is needed until
 * the reader presses play.
 * @param props - document bytes, resource identity, and locale.
 * @returns the player, contained by the pane's width and height.
 */
export function VideoBody({ content, resourceAddress, t }: VideoBodyProps): ReactNode {
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const mediaType = videoMediaType(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<VideoSource>()

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ kind: 'ready', data, mediaType, url })
    } catch {
      // A Blob URL is the only way the bytes reach a media element, so a
      // refused allocation is a preview this pane cannot show.
      setSource({ kind: 'failed', data, mediaType })
    }
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, mediaType])

  if (data === undefined || mediaType === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data || source.mediaType !== mediaType) {
    return <LoadingIndicator className={css.status} label={t('loading')} />
  }
  if (source.kind === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  const { name } = pathPartsOf(path)
  return <LoadedVideo key={source.url} url={source.url} name={name} t={t} />
}

/** The mounted player: its own controls, and a failure line when playback itself is refused. */
function LoadedVideo({ url, name, t }: {
  readonly url: string
  readonly name: string
  readonly t: VideoBodyProps['t']
}): ReactNode {
  const [failed, setFailed] = useState(false)
  return <div className={css.frame} data-video-preview>
    {failed && <p className={css.status} role="alert">{t('failed')}</p>}
    <video
      className={css.video}
      src={url}
      controls
      preload="metadata"
      playsInline
      aria-label={t('preview', { name })}
      hidden={failed}
      onError={() => { setFailed(true) }}
    />
  </div>
}
