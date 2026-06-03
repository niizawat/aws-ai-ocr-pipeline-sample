import { redirect } from 'next/navigation';

type LoginPageProps = {
  searchParams: Promise<{ callbackUrl?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl ?? '/';
  redirect(
    `/api/login/start?callbackUrl=${encodeURIComponent(callbackUrl)}`,
  );
}
