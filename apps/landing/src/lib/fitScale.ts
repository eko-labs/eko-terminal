import { useLayoutEffect, useRef, useState } from 'react'

/** Content-box size, as a ResizeObserver reports it. */
function contentBox(el: HTMLElement) {
  const cs = getComputedStyle(el)
  return {
    width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  }
}

/**
 * Scale for a fixed-width design drawn into a fluid box. Measured once before the first paint (a layout effect) and
 * then on every resize: measuring only in the observer left a frame at scale 1 / height 0, which shifted the page.
 */
export function useFitScale(designWidth: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const width = contentBox(el).width
    if (width) setScale(width / designWidth)
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setScale(w / designWidth)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [designWidth])

  return { ref, scale }
}

/** useFitScale for a design whose height is its content's: the outer box takes the inner one's height times the scale. */
export function useFitScaleAuto(designWidth: number) {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [naturalHeight, setNaturalHeight] = useState(0)

  useLayoutEffect(() => {
    const el = outerRef.current
    if (!el) return
    const width = contentBox(el).width
    if (width) setScale(width / designWidth)
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setScale(w / designWidth)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [designWidth])

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const height = contentBox(el).height
    if (height) setNaturalHeight(height)
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h) setNaturalHeight(h)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { outerRef, innerRef, scale, naturalHeight }
}
