export const judgeSignInPath = "/sign-in/judge"

export const authRoutes = [
  { id: "session", method: "GET", path: "/get-session", judgeOnly: false, rateLimit: null },
  { id: "options", method: "GET", path: "/sign-in-options", judgeOnly: false, rateLimit: null },
  { id: "email", method: "POST", path: "/sign-in/email", judgeOnly: false, rateLimit: { window: 60, max: 10 } },
  { id: "judge", method: "POST", path: judgeSignInPath, judgeOnly: true, rateLimit: { window: 60, max: 20 } },
  { id: "signOut", method: "POST", path: "/sign-out", judgeOnly: false, rateLimit: null },
] as const

export const authRateLimits = Object.fromEntries(authRoutes.flatMap((route) =>
  route.rateLimit === null ? [] : [[route.path, route.rateLimit]],
))
