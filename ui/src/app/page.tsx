export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <div className="relative mx-auto size-24">
          <div
            aria-hidden
            className="absolute inset-0 animate-pulse rounded-full bg-[#2AABEE]/30 blur-2xl"
          />
          <div
            aria-hidden
            className="relative flex size-24 items-center justify-center rounded-full bg-gradient-to-br from-[#2AABEE] to-[#229ED9] text-5xl shadow-xl shadow-[#2AABEE]/40"
          >
            😽
          </div>
        </div>
        <h1 className="mt-6 bg-gradient-to-r from-[#2AABEE] to-[#229ED9] bg-clip-text text-3xl font-black tracking-tight text-transparent">
          DeFiCat
        </h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          Chat to DeFiCat on Telegram. It sends the sign-in link that lands
          here.
        </p>
      </div>
    </div>
  );
}
