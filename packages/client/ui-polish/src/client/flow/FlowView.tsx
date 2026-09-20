/**
 * Conversation flow view: one Session drawn as a star-domain graph. The centre
 * is the router (启明), the human node hangs in front of it, and every activity
 * the session performed sits on a ring around the centre. Figures are
 * procedural (three.js primitives only): a palace lantern for the router, seals
 * for the seats, a low desk for the human, beads for tools — so the view ships
 * no model assets and stays readable at any size.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EMPTY_FLOW_GRAPH, FLOW_HUB_ID, type FlowGraph, type FlowKind, type FlowNode } from './flow-graph.ts'

/** Injected face: the Session's flow target, absent until its binding assembles. */
export interface FlowViewInjected {
  /** Observable graph for the bound Session. */
  readonly source: ObservableSnapshot<FlowGraph | undefined>
}

/** Full component props: runtime share, locale seat, and the injected target. */
export type FlowViewProps =
  PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'> & FlowViewInjected

/** Radius of the activity ring, in world units. */
const RING_RADIUS = 4.6

/** Half-extent of the orthographic frustum; the resize handler keeps the aspect. */
const FRUSTUM_HALF = 6.4

/** Ink-and-gold palette: the unlit colour of one node class. */
const KIND_COLOR: Readonly<Record<FlowKind, number>> = {
  human: 0x5a6b7d,
  agent: 0xd8a24a,
  seat: 0xc4553f,
  command: 0x8f7bd8,
  tool: 0x4f9d8b,
  mcp: 0x3f7fb5,
  skill: 0xb07d3a,
  subagent: 0x7a8f4a,
  notice: 0xb5453f,
}

/** Unsettled states override the class colour, so motion and failure read first. */
const STATE_COLOR: Readonly<Record<'running' | 'error', number>> = {
  running: 0xe8c35a,
  error: 0xd23b3b,
}

/** Figure colour for one activity: run state first, then the node class. */
function colorOf(node: FlowNode): number {
  return node.state === 'running' || node.state === 'error'
    ? STATE_COLOR[node.state]
    : KIND_COLOR[node.kind]
}

/** Ring angle for one activity, spread evenly and offset off the front axis. */
function ringAngle(index: number, total: number): number {
  return Math.PI / 2 + (index / Math.max(total, 1)) * Math.PI * 2
}

/** The router figure: a palace-lantern body under a glowing cap. */
function lanternFigure(color: number): THREE.Object3D {
  const group = new THREE.Group()
  const profile: THREE.Vector2[] = []
  for (let step = 0; step <= 16; step += 1) {
    const t = step / 16
    // A lantern silhouette: narrow neck, wide belly, narrow foot.
    profile.push(new THREE.Vector2(0.35 + Math.sin(t * Math.PI) * 0.85, (t - 0.5) * 1.9))
  }
  group.add(new THREE.Mesh(
    new THREE.LatheGeometry(profile, 24),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5 }),
  ))
  const cap = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.06, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xf2d9a0, emissive: 0xf2d9a0, emissiveIntensity: 0.6 }),
  )
  cap.position.y = 1.05
  cap.rotation.x = Math.PI / 2
  group.add(cap)
  return group
}

/** One activity figure: seats get a seal, the human a desk, everything else a bead. */
function activityFigure(kind: FlowKind, color: number): THREE.Object3D {
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.6 })
  if (kind === 'seat') {
    const group = new THREE.Group()
    group.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.42), material))
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.045, 8, 28),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 }),
    )
    ring.rotation.x = Math.PI / 2
    group.add(ring)
    return group
  }
  if (kind === 'human') {
    // A low desk: the human's node is furniture in the flow, not a machine.
    const group = new THREE.Group()
    group.add(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.1, 0.55), material))
    for (const x of [-0.35, 0.35]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), material)
      leg.position.set(x, -0.3, 0)
      group.add(leg)
    }
    return group
  }
  const size = kind === 'command' ? 0.34 : kind === 'notice' ? 0.4 : 0.26
  return new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), material)
}

/** Live WebGL state owned by one mounted view. */
interface Mounted {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.OrthographicCamera
  readonly world: THREE.Group
  readonly startedAt: number
}

/** Render the star-domain flow for the bound Session. */
export function FlowView({ source, t }: FlowViewProps) {
  const graph = useSyncExternalStore(source.subscribe, () => source.getSnapshot() ?? EMPTY_FLOW_GRAPH)
  const host = useRef<HTMLDivElement | null>(null)
  const mounted = useRef<Mounted | null>(null)

  useEffect(() => {
    const element = host.current
    if (element === null) return undefined
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, 2))
    element.append(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-FRUSTUM_HALF, FRUSTUM_HALF, FRUSTUM_HALF, -FRUSTUM_HALF, 0.1, 100)
    camera.position.set(0, 0.8, 14)
    camera.lookAt(0, 0, 0)
    scene.add(new THREE.AmbientLight(0xffffff, 1.7))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(4, 6, 8)
    scene.add(key)
    const world = new THREE.Group()
    scene.add(world)
    const resize = (): void => {
      const { clientWidth, clientHeight } = element
      renderer.setSize(clientWidth, clientHeight, false)
      const aspect = clientHeight === 0 ? 1 : clientWidth / clientHeight
      camera.left = -FRUSTUM_HALF
      camera.right = FRUSTUM_HALF
      camera.top = FRUSTUM_HALF / aspect
      camera.bottom = -FRUSTUM_HALF / aspect
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const state: Mounted = { renderer, scene, camera, world, startedAt: performance.now() }
    mounted.current = state
    let frame = requestAnimationFrame(function draw(): void {
      frame = requestAnimationFrame(draw)
      // A slow sway is what tells the eye the scene is live; it also survives
      // `prefers-reduced-motion` because the angle change is small and linear.
      const elapsed = (performance.now() - state.startedAt) / 1000
      world.rotation.y = Math.sin(elapsed * 0.12) * 0.3
      renderer.render(scene, camera)
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mounted.current = null
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  useEffect(() => {
    const state = mounted.current
    if (state === null) return
    for (const child of [...state.world.children]) state.world.remove(child)
    if (graph.nodes.some(node => node.id === FLOW_HUB_ID)) {
      const figure = lanternFigure(KIND_COLOR.agent)
      figure.rotation.y = 0.4
      state.world.add(figure)
    }
    const activities = graph.nodes.filter(node => node.id !== FLOW_HUB_ID)
    activities.forEach((node, index) => {
      const angle = ringAngle(index, activities.length)
      const x = Math.cos(angle) * RING_RADIUS
      const z = Math.sin(angle) * RING_RADIUS
      const color = colorOf(node)
      const figure = activityFigure(node.kind, color)
      figure.position.set(x, 0, z)
      figure.lookAt(0, 0, 0)
      state.world.add(figure)
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, 0, z)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: node.state === 'running' ? 0.85 : 0.4 }),
      )
      state.world.add(line)
    })
  }, [graph])

  return (
    <div
      ref={host}
      data-ui-polish-flow=""
      aria-label={t('flow.canvas')}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      {/* A canvas is opaque to assistive technology, so the same graph is also
          written as text: the summary is the accessible reading of the scene. */}
      <p data-ui-polish-flow-summary="" style={VISUALLY_HIDDEN}>
        {graph.nodes.length <= 1
          ? t('flow.empty')
          : t('flow.summary', {
            count: graph.nodes.length - 1,
            nodes: graph.nodes.filter(node => node.id !== FLOW_HUB_ID).map(node => node.label).join('、'),
          })}
      </p>
    </div>
  )
}

/** Screen-reader-only styling for the graph summary. */
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
} as const
