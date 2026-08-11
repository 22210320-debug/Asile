(() => {
  const transition = document.querySelector('.events-transition');
  if (!transition) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = navigator.connection?.saveData;
  const sunsetSource = '/public/sunset-house-party-background.jpg';
  const undergroundSource = '/public/underground-red-carpet.jpg';
  const canUseMotion = !reducedMotion.matches && !saveData;
  const canUseMouse = canUseMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const canUseOrientation =
    canUseMotion &&
    window.matchMedia('(pointer: coarse)').matches &&
    'DeviceOrientationEvent' in window &&
    typeof window.DeviceOrientationEvent.requestPermission !== 'function';

  Promise.all(
    [sunsetSource, undergroundSource].map(
      (source) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () =>
            image.decode
              ? image
                  .decode()
                  .catch(() => undefined)
                  .finally(resolve)
              : resolve();
          image.onerror = resolve;
          image.src = source;
        })
    )
  ).then(() => transition.classList.add('images-ready'));

  if (!canUseMotion) return;

  let active = false;
  let frameId = 0;
  let pointerX = 0;
  let pointerY = 0;

  function updateScene() {
    frameId = 0;
    if (!active) return;

    const rect = transition.getBoundingClientRect();
    const viewport = window.innerHeight || 1;
    const scrollDistance = Math.max(rect.height - viewport, 1);
    const progress = Math.min(1, Math.max(0, -rect.top / scrollDistance));
    transition.style.setProperty('--transition-progress', progress.toFixed(3));
    transition.style.setProperty('--parallax-x', `${pointerX.toFixed(1)}px`);
    transition.style.setProperty('--parallax-y', `${pointerY.toFixed(1)}px`);
  }

  function requestUpdate() {
    if (active && !frameId) frameId = window.requestAnimationFrame(updateScene);
  }

  new IntersectionObserver(
    ([entry]) => {
      active = entry.isIntersecting;
      if (active) requestUpdate();
    },
    { rootMargin: '20% 0px' }
  ).observe(transition);

  if (canUseMouse) {
    window.addEventListener(
      'pointermove',
      (event) => {
        pointerX = ((event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1) * 8;
        pointerY = ((event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1) * 8;
        requestUpdate();
      },
      { passive: true }
    );
  }

  if (canUseOrientation) {
    window.addEventListener(
      'deviceorientation',
      (event) => {
        pointerX = Math.max(-3, Math.min(3, (event.gamma || 0) / 10));
        pointerY = Math.max(-3, Math.min(3, (event.beta || 0) / 20));
        requestUpdate();
      },
      { passive: true }
    );
  }

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
})();
