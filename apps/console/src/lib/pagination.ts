/** 总页数，至少 1。 */
export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size))

/** K-30：删除/处理后当前页可能超出总页数，回到最后一个有数据的页（没有数据时回第 1 页）。 */
export const clampPage = (page: number, total: number, size: number) => Math.min(Math.max(1, page), pageCount(total, size))

/** 有数据或不在第 1 页时显示分页器，避免用户停在空页上回不去。 */
export const showPager = (total: number, page: number) => total > 0 || page > 1
