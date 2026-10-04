import Image from 'next/image';

export function LaunchpadIcon({ platform }: { platform: string }) {
  if (platform !== 'pons') return null;

  return (
    <Image
      src="/images/launchpads/pons.webp"
      alt="Pons logo"
      width={20}
      height={20}
      unoptimized
      className="h-5 w-5 shrink-0 object-contain"
    />
  );
}
