/** @type {import('next').NextConfig} */
// Backend origin for the /api rewrite. In production nginx already proxies
// /api, but `next start` needs a valid target too — make it configurable
// instead of hardcoding localhost.
const API_TARGET = process.env.API_REWRITE_URL || process.env.API_URL || 'http://localhost:3000';

const nextConfig = {
  reactStrictMode: true,
  // 1.0.0 renamed miners to workers — keep old bookmarks and shared links alive.
  async redirects() {
    return [
      { source: '/miner', destination: '/worker', permanent: true },
      { source: '/miners', destination: '/workers', permanent: true },
      // The public leaderboard was removed (admin panel only).
      { source: '/leaderboard', destination: '/', permanent: true },
      // Organizations became teams.
      { source: '/org', destination: '/team', permanent: true },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_TARGET}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
