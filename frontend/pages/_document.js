import { Html, Head, Main, NextScript } from 'next/document';

const SITE = 'https://plankton.click';
const TITLE = 'Plankton — a swarm of GPUs answering your AI chats';
const DESCRIPTION = 'Plankton is a decentralized LLM network: chat with open models served by a swarm of community GPU workers, or run a worker and earn from every paid reply.';

export default function Document() {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta charSet="UTF-8" />
        {/* viewport-fit=cover enables env(safe-area-inset-*) for notched iPhones;
            interactive-widget makes Android resize the layout when the keyboard
            opens. Neither restricts pinch-zoom (no maximum-scale — keep it that way). */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />
        <meta name="theme-color" content="#082b33" />
        <meta name="description" content={DESCRIPTION} />
        <meta name="keywords" content="decentralized AI, LLM inference, GPU worker, open models, Ollama, AI chat, Plankton" />
        <meta name="author" content="Plankton Network" />
        <meta name="robots" content="index, follow" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${SITE}/`} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:image" content={`${SITE}/og-image.png`} />
        <meta property="og:site_name" content="Plankton" />
        <meta property="og:locale" content="en_US" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:url" content={`${SITE}/`} />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={`${SITE}/og-image.png`} />
        <link rel="canonical" href={`${SITE}/`} />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'Plankton',
              url: SITE,
              description: DESCRIPTION,
              applicationCategory: 'AIApplication',
              operatingSystem: 'Web',
              softwareVersion: '1.0.0',
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
              creator: { '@type': 'Organization', name: 'Plankton Network' },
            }),
          }}
        />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
