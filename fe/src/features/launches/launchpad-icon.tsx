import Image from 'next/image';

export function launchpadName(platform: string): string {
  const names: Record<string, string> = {
    pons: 'Pons',
    'full.fun': 'full.fun',
    bow: 'Bow',
    noxa: 'NOXA',
    bankr: 'Bankr',
    'pools.xyz': 'pools.xyz',
    'letscash.fun': 'letscash.fun',
    long: 'Long',
    varo: 'Varo',
  };
  return names[platform.toLowerCase()] ?? platform;
}

const LAUNCHPAD_ICONS: Record<string, string> = {
  pons: '/images/launchpads/pons.webp',
  'full.fun': '/images/launchpads/full-fun.svg',
  bow: '/images/launchpads/bow.png',
  noxa: '/images/launchpads/noxa.jpeg',
  bankr: '/images/launchpads/bankr.jpeg',
  'pools.xyz': '/images/launchpads/pools-xyz.svg',
  'letscash.fun': '/images/launchpads/letscash-fun.png',
  long: '/images/launchpads/long.webp',
  varo: '/images/launchpads/varo.jpg',
};

export function launchpadIconSrc(platform: string): string | undefined {
  return LAUNCHPAD_ICONS[platform.toLowerCase()];
}

export function LaunchpadIcon({ platform, decorative = false }: { platform: string; decorative?: boolean }) {
  const src = launchpadIconSrc(platform);
  if (!src) return null;

  return (
    <Image
      src={src}
      alt={decorative ? '' : `${launchpadName(platform)} logo`}
      width={20}
      height={20}
      unoptimized
      className="h-5 w-5 shrink-0 object-contain"
    />
  );
}
