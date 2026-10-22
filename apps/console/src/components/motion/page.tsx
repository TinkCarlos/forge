import { motion } from 'motion/react'

/** 页面进入：轻微上移 + 淡入。减少动态效果时由 MotionConfig 降级为纯淡入。 */
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** 列表行纯淡入，错开延迟上限 0.12s，没有位移。 */
export const rowMotion = (index: number) => ({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.16, delay: Math.min(index * 0.015, 0.12), ease: 'easeOut' as const },
})
