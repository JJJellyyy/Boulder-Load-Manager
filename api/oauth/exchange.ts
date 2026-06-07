import type { VercelRequest, VercelResponse } from "@vercel/node";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

interface TokenExchangeRequest {
  code: string;
  code_verifier: string;
  client_id: string;
  redirect_uri: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, code_verifier, client_id, redirect_uri } = req.body as TokenExchangeRequest;

  // Validate required fields
  if (!code || !code_verifier || !client_id || !redirect_uri) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Get client secret from environment
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) {
    console.error("GOOGLE_CLIENT_SECRET not configured");
    return res.status(500).json({ error: "Server not configured for OAuth" });
  }

  try {
    // Exchange auth code for access token
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id,
      client_secret: clientSecret,
      redirect_uri,
      code_verifier,
    });

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Token exchange failed:", error);
      return res.status(response.status).json({ error: "Token exchange failed" });
    }

    const tokenData = (await response.json()) as TokenResponse;
    return res.status(200).json({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
    });
  } catch (error) {
    console.error("OAuth token exchange error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
