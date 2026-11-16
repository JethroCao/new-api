package middleware

// Keep the extension's authorization declaration out of the official catalog.
// This financial dashboard is session-only; existing API/PAT keys gain no access.
func init() {
	accessTokenRouteRules["GET /api/user/promotion"] = accessTokenSessionRule
}
