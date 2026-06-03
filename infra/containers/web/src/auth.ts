import { betterAuth } from 'better-auth';

const authEnabled =
  (process.env.AUTH_ENABLED ?? 'false').toLowerCase() === 'true';
const resolvedBaseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
const resolvedSecret =
  process.env.BETTER_AUTH_SECRET ?? 'build-only-secret-change-in-runtime';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when AUTH_ENABLED=true.`);
  }
  return value;
}

if (authEnabled && !process.env.BETTER_AUTH_SECRET) {
  throw new Error(
    'BETTER_AUTH_SECRET is required when AUTH_ENABLED=true.',
  );
}

export const auth = betterAuth({
  baseURL: resolvedBaseUrl,
  secret: resolvedSecret,
  trustedOrigins: [resolvedBaseUrl],
  advanced: {
    useSecureCookies: resolvedBaseUrl.startsWith('https'),
  },
  socialProviders: authEnabled
    ? {
        cognito: {
          clientId: requireEnv('COGNITO_CLIENT_ID'),
          clientSecret: requireEnv('COGNITO_CLIENT_SECRET'),
          domain: requireEnv('COGNITO_DOMAIN'),
          region: requireEnv('COGNITO_REGION'),
          userPoolId: requireEnv('COGNITO_USER_POOL_ID'),
        },
      }
    : {},
});

export const isAuthEnabled = authEnabled;
