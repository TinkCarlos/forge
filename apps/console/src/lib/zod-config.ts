import { z } from 'zod'

// FE-CSP-02：zod 4 首次解析对象 schema 时会用 new Function 探测能否 JIT；
// /next/ 的 script-src 'self' 会把这次探测记成 securitypolicyviolation（即使异常被吞掉）。
// jitless 跳过探测和 JIT，必须在任何 schema 解析前生效，所以 main.tsx 第一条就引入本文件。
z.config({ jitless: true })
