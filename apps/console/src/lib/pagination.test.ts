import { describe, expect, it } from 'vitest'
import { clampPage, pageCount, showPager } from './pagination'

describe('K-30 分页收缩', () => {
  it('当前页超出总页数时回到最后一页', () => {
    expect(clampPage(2, 20, 20)).toBe(1)
    expect(clampPage(3, 41, 20)).toBe(3)
    expect(clampPage(5, 41, 20)).toBe(3)
  })
  it('一条都没有时回到第 1 页；页码不会小于 1', () => {
    expect(clampPage(4, 0, 20)).toBe(1)
    expect(clampPage(0, 10, 20)).toBe(1)
  })
  it('pageCount 至少 1', () => {
    expect(pageCount(0, 20)).toBe(1)
    expect(pageCount(21, 20)).toBe(2)
  })
  it('分页器在有数据或不在第 1 页时都显示，用户总能翻回去', () => {
    expect(showPager(20, 1)).toBe(true)
    expect(showPager(0, 2)).toBe(true)
    expect(showPager(0, 1)).toBe(false)
  })
})
