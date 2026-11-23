import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface NavigatorWithBrave extends Navigator {
  brave?: {
    isBrave?: () => Promise<boolean>;
  };
  standalone?: boolean;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  const [isBrave, setIsBrave] = useState(false);
  const [isInIframe, setIsInIframe] = useState(false);
  const [swReady, setSwReady] = useState(false);

  useEffect(() => {
    const nav = window.navigator as NavigatorWithBrave;
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
    setIsInstalled(isStandalone);

    const ua = nav.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));
    setIsAndroid(/android/.test(ua));

    try {
      setIsInIframe(window.self !== window.top);
    } catch {
      setIsInIframe(true);
    }

    if (nav.brave?.isBrave) {
      nav.brave
        .isBrave()
        .then((res) => setIsBrave(Boolean(res)))
        .catch(() => {});
    }

    if ('serviceWorker' in nav) {
      nav.serviceWorker
        .getRegistrations()
        .then((regs) => {
          if (regs.length > 0) setSwReady(true);
        })
        .catch(() => {});
      nav.serviceWorker.ready
        .then(() => setSwReady(true))
        .catch(() => {});
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const install = async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    isAndroid,
    isBrave,
    isInIframe,
    swReady,
    install,
  };
}
