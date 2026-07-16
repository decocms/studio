import { AuthEntry } from "@/web/components/auth-entry";
import type { UnifiedAuthFormCopy } from "@/web/components/unified-auth-form";
import { brandFromDomain, faviconForDomain } from "@/shared/report-seo";
import { captureReport } from "./track";
import { DECK } from "./templates/tokens";

const REPORT_AUTH_COPY = {
  otpSendFailed: "Não foi possível enviar o código",
  invalidCode: "Código inválido",
  invalidEmail: "Digite um email válido",
  networkError: "Erro de conexão. Tente novamente.",
  tooManyAttempts: "Muitas tentativas. Aguarde um momento e tente novamente.",
  invalidOrExpiredCode: "Código inválido ou expirado. Tente novamente.",
  genericError: "Algo deu errado. Tente novamente.",
  verificationCodeTitle: "Digite o código",
  codeSentTo: (email: string) => `Enviamos um código para ${email}`,
  continueWith: (provider: string) => `Continuar com ${provider}`,
  divider: "ou",
  emailLabel: "Email",
  emailPlaceholder: "seu@email.com",
  sending: "Enviando...",
  sendCode: "Continuar",
  verificationCodeLabel: "Código de verificação",
  enterCodePlaceholder: "Digite o código",
  verifying: "Verificando...",
  verify: "Entrar",
  useDifferentEmail: "Usar outro email",
} satisfies Partial<UnifiedAuthFormCopy>;

function callbackUrl(domain: string): string {
  const path = `/report/${encodeURIComponent(domain)}`;
  if (typeof window === "undefined") return path;
  return `${path}${window.location.search}${window.location.hash}`;
}

function ReportBackdrop({ domain }: { domain: string }) {
  const brand = brandFromDomain(domain);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-[-18px] select-none overflow-hidden"
      style={{
        background: DECK.bg,
        color: DECK.ink,
        filter: "blur(9px)",
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        transform: "scale(1.025)",
      }}
    >
      <div className="flex h-full min-h-[640px] flex-col px-6 py-5 sm:px-10 sm:py-8 lg:px-16">
        <header
          className="flex items-center justify-between border-b pb-5"
          style={{ borderColor: DECK.border }}
        >
          <div className="flex items-center gap-3">
            <img
              src={faviconForDomain(domain)}
              alt=""
              className="h-8 w-8 rounded-lg object-contain"
            />
            <div>
              <p className="text-sm font-medium">{brand}</p>
              <p className="text-xs" style={{ color: DECK.faint }}>
                {domain}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="h-2 w-16 rounded-full"
              style={{ background: DECK.border }}
            />
            <span
              className="h-9 w-24 rounded-full"
              style={{ background: DECK.ink }}
            />
          </div>
        </header>

        <main className="grid min-h-0 flex-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)] lg:gap-14">
          <div className="space-y-7">
            <div className="space-y-4">
              <p
                className="text-xs font-medium uppercase tracking-[0.08em]"
                style={{ color: DECK.soft }}
              >
                Relatório de comércio digital
              </p>
              <h1 className="max-w-[13ch] text-4xl font-normal leading-[1.04] tracking-[-0.035em] sm:text-6xl">
                Uma visão completa da sua loja.
              </h1>
              <p
                className="max-w-[38rem] text-base leading-7"
                style={{ color: DECK.muted }}
              >
                Oportunidades, comparativos e próximos passos reunidos em um
                único relatório.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {["Experiência", "Descoberta", "Conversão", "Operação"].map(
                (label, index) => (
                  <div
                    key={label}
                    className="rounded-2xl border p-4"
                    style={{ borderColor: DECK.border, background: "#fff" }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm" style={{ color: DECK.muted }}>
                        {label}
                      </span>
                      <span className="text-2xl font-light">
                        {72 + index * 5}
                      </span>
                    </div>
                    <div
                      className="mt-4 h-1.5 overflow-hidden rounded-full"
                      style={{ background: DECK.border }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          background: DECK.soft,
                          width: `${54 + index * 9}%`,
                        }}
                      />
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>

          <div
            className="relative hidden h-[min(68vh,660px)] min-h-[430px] overflow-hidden rounded-[2rem] border p-8 lg:block"
            style={{
              borderColor: DECK.border,
              background:
                "radial-gradient(circle at 18% 18%, rgba(208,236,26,.45), transparent 35%), radial-gradient(circle at 82% 30%, rgba(152,221,255,.7), transparent 34%), radial-gradient(circle at 60% 86%, rgba(255,183,214,.65), transparent 42%), #f7f5ef",
            }}
          >
            <div
              className="absolute inset-x-8 top-8 rounded-2xl border bg-white p-3 shadow-xl"
              style={{ borderColor: DECK.border }}
            >
              <div
                className="mb-3 flex items-center gap-2 border-b pb-3"
                style={{ borderColor: DECK.border }}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b67]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#f5c451]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#65c466]" />
                <span
                  className="ml-3 h-6 flex-1 rounded-full"
                  style={{ background: DECK.bg }}
                />
              </div>
              <div className="grid h-[330px] grid-cols-[0.72fr_1.28fr] gap-3">
                <div
                  className="space-y-3 rounded-xl p-4"
                  style={{ background: DECK.forest }}
                >
                  <div className="h-3 w-16 rounded-full bg-white/30" />
                  <div className="h-8 w-full rounded-lg bg-white/80" />
                  <div className="h-3 w-4/5 rounded-full bg-white/30" />
                  <div className="mt-8 h-24 rounded-xl bg-white/10" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {[0, 1, 2, 3].map((item) => (
                    <div
                      key={item}
                      className="rounded-xl border bg-white p-3"
                      style={{ borderColor: DECK.border }}
                    >
                      <div
                        className="h-24 rounded-lg"
                        style={{ background: DECK.bg }}
                      />
                      <div
                        className="mt-3 h-3 w-4/5 rounded-full"
                        style={{ background: DECK.border }}
                      />
                      <div
                        className="mt-2 h-3 w-1/2 rounded-full"
                        style={{ background: DECK.border }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="absolute bottom-8 left-8 right-8 flex items-center justify-between rounded-2xl bg-white/85 px-5 py-4 shadow-lg">
              <div className="space-y-2">
                <div
                  className="h-3 w-28 rounded-full"
                  style={{ background: DECK.border }}
                />
                <div
                  className="h-5 w-44 rounded-full"
                  style={{ background: DECK.ink }}
                />
              </div>
              <div
                className="h-12 w-12 rounded-full"
                style={{ background: DECK.soft }}
              />
            </div>
          </div>
        </main>

        <footer
          className="flex items-center justify-between border-t pt-5"
          style={{ borderColor: DECK.border }}
        >
          <span
            className="h-2 w-24 rounded-full"
            style={{ background: DECK.border }}
          />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((item) => (
              <span
                key={item}
                className="h-2 rounded-full"
                style={{
                  background: item === 0 ? DECK.ink : DECK.border,
                  width: item === 0 ? 28 : 8,
                }}
              />
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}

export function ReportAuthGate({
  domain,
  loading = false,
}: {
  domain: string;
  loading?: boolean;
}) {
  const trackGateRef = (element: HTMLDivElement | null) => {
    if (!element || loading || element.dataset.tracked === "true") return;
    element.dataset.tracked = "true";
    captureReport("report_auth_gate_shown", {
      domain,
      surface: "deck_v2",
    });
  };

  return (
    <div
      ref={trackGateRef}
      className="fixed inset-0 overflow-y-auto"
      style={{
        color: DECK.ink,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <ReportBackdrop domain={domain} />
      <div className="absolute inset-0 bg-white/35" />

      <div className="relative z-10 flex min-h-full items-center justify-center px-3 py-5 sm:px-6 sm:py-10">
        {loading ? (
          <div
            className="h-[330px] w-full max-w-[440px] animate-pulse rounded-3xl bg-white/90"
            aria-label="Carregando sessão"
          />
        ) : (
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Acesse seu relatório"
            className="w-full max-w-[440px] rounded-2xl bg-white px-5 py-5 shadow-2xl sm:rounded-3xl sm:px-7 sm:py-7"
          >
            <AuthEntry
              callbackUrl={callbackUrl(domain)}
              title="Acesse seu relatório"
              subtitle="Entre ou crie sua conta para ver a análise completa."
              variant="compact"
              allowedSocialProviders={["google"]}
              allowPassword={false}
              brand={
                <div className="flex items-center justify-between gap-4">
                  <div
                    className="inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1.5"
                    style={{ borderColor: DECK.border, background: DECK.bg }}
                  >
                    <img
                      src={faviconForDomain(domain)}
                      alt=""
                      className="h-4 w-4 shrink-0 rounded object-contain"
                    />
                    <span
                      className="truncate text-[13px]"
                      style={{ color: DECK.muted }}
                    >
                      {domain}
                    </span>
                  </div>
                  <img
                    src="/logos/deco logo.svg"
                    alt="Deco"
                    className="h-7 w-7 shrink-0"
                  />
                </div>
              }
              copy={REPORT_AUTH_COPY}
            />
            <p
              className="mt-5 text-center text-xs leading-5"
              style={{ color: DECK.faint }}
            >
              Acesso gratuito. Leva menos de um minuto.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
