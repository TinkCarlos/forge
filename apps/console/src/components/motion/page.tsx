import { motion } from 'motion/react'

/** 页面进入：轻微上移 + 淡入。减少动态效果时由 MotionConfig 降级为纯淡入。 */
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** 列表行依次出现，单行延迟上限 0.3s，长列表不拖沓。 */
export const rowMotion = (index: number) => ({
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, delay: Math.min(index * 0.025, 0.3), ease: [0.22, 1, 0.36, 1] as const },
})
