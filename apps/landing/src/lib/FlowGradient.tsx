import { useEffect, useRef, type CSSProperties } from 'react'

/**
 * Slowly flowing warm gradient (domain-warped noise in a fragment shader) that
 * reacts to the cursor: the colors swirl around the pointer and a soft hot spot
 * follows it. Raw WebGL, no three.js. Fills its parent (position absolute,
 * inset 0); put a static fallback image underneath for browsers without WebGL.
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uHover;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 m = vec2(uMouse.x * aspect, uMouse.y);

  // swirl around the pointer
  vec2 d = p - m;
  float dist = length(d);
  float infl = uHover * exp(-dist * dist * 6.0);
  float ang = infl * 2.2;
  p = m + mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;

  float t = uTime * 0.06;
  vec2 q = vec2(fbm(p * 1.4 + vec2(0.0, t)), fbm(p * 1.4 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p * 1.4 + 3.0 * q + vec2(1.7, 9.2) + t * 1.3),
                fbm(p * 1.4 + 3.0 * q + vec2(8.3, 2.8) - t * 0.9));
  float f = fbm(p * 1.4 + 3.0 * r);

  vec3 deep   = vec3(0.012, 0.031, 0.047);
  vec3 brown  = vec3(0.047, 0.082, 0.106);
  vec3 orange = vec3(0.561, 0.792, 0.941);
  vec3 gold   = vec3(0.839, 0.925, 0.980);

  vec3 col = mix(deep, brown, smoothstep(0.15, 0.55, f));
  col = mix(col, orange, smoothstep(0.35, 0.8, length(q)));
  col = mix(col, gold, smoothstep(0.55, 0.95, r.x) * 0.7);
  col = mix(col, deep, smoothstep(0.55, 0.9, q.y) * 0.6);

  // warm hot spot under the cursor
  col += vec3(0.10, 0.20, 0.26) * infl * 0.8;

  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export default function FlowGradient({ className, style }: { className?: string; style?: CSSProperties }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
    if (!gl) {
      canvas.style.display = 'none'
      return
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const program = gl.createProgram()
    if (!vs || !fs || !program) {
      canvas.style.display = 'none'
      return
    }
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      canvas.style.display = 'none'
      return
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'uRes')
    const uTime = gl.getUniformLocation(program, 'uTime')
    const uMouse = gl.getUniformLocation(program, 'uMouse')
    const uHover = gl.getUniformLocation(program, 'uHover')

    // pointer in 0..1 canvas space (y up, like gl_FragCoord), smoothed every frame
    const target = { x: 0.5, y: 0.5, inside: false }
    const mouse = { x: 0.5, y: 0.5 }
    let hover = 0
    let visible = false
    let raf = 0
    const start = performance.now()

    function onPointerMove(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const x = (e.clientX - rect.left) / rect.width
      const y = 1 - (e.clientY - rect.top) / rect.height
      target.inside = x >= 0 && x <= 1 && y >= 0 && y <= 1
      if (target.inside) {
        target.x = x
        target.y = y
      }
    }

    function frame(now: number) {
      raf = 0
      if (!visible) return
      const rect = canvas!.getBoundingClientRect()
      // a soft gradient needs no retina resolution; keep the fragment cost low
      const bw = Math.max(1, Math.round(rect.width))
      const bh = Math.max(1, Math.round(rect.height))
      if (canvas!.width !== bw || canvas!.height !== bh) {
        canvas!.width = bw
        canvas!.height = bh
        gl!.viewport(0, 0, bw, bh)
      }
      hover += ((target.inside ? 1 : 0) - hover) * 0.05
      mouse.x += (target.x - mouse.x) * 0.06
      mouse.y += (target.y - mouse.y) * 0.06

      gl!.uniform2f(uRes, bw, bh)
      gl!.uniform1f(uTime, (now - start) / 1000)
      gl!.uniform2f(uMouse, mouse.x, mouse.y)
      gl!.uniform1f(uHover, hover)
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4)
      raf = requestAnimationFrame(frame)
    }

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible && !raf) raf = requestAnimationFrame(frame)
    })
    io.observe(canvas)
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      gl.deleteBuffer(buffer)
    }
  }, [])

  return <canvas ref={canvasRef} className={className} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', ...style }} />
}
