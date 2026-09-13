import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Dimensions, Keyboard, Modal, ScrollView, TextInput, View, type KeyboardEvent, type ModalProps, type ScrollViewProps, type TextInputProps } from 'react-native';
import { inputScrollDelta } from '@/lib/input-scroll-layout';

const InputViewport = createContext<((input?: TextInput | null) => void) | null>(null);
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/** 縮小前の外枠を測り続け、内側だけ余白を取る。IME非表示では必ず0へ戻す。 */
export function KeyboardViewport({ children }: { children: ReactNode }) {
  const root = useRef<View | null>(null);
  const [frame, setFrame] = useState({ y: 0, height: 0 });
  const [keyboardTop, setKeyboardTop] = useState<number | null>(() => Keyboard.isVisible() ? Keyboard.metrics()?.screenY ?? null : null);
  const measure = useCallback(() => root.current?.measureInWindow((_x, y, _width, height) => {
    setFrame((previous) => previous.y === y && previous.height === height ? previous : { y, height });
  }), []);
  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      const { screenY, height } = event.endCoordinates;
      setKeyboardTop(height > 0 && screenY < Dimensions.get('screen').height ? screenY : null);
    };
    const subscriptions = [
      ...(['keyboardWillShow', 'keyboardDidShow', 'keyboardWillChangeFrame', 'keyboardDidChangeFrame'] as const)
        .map((event) => Keyboard.addListener(event, show)),
      ...(['keyboardWillHide', 'keyboardDidHide'] as const)
        .map((event) => Keyboard.addListener(event, () => setKeyboardTop(null))),
      Dimensions.addEventListener('change', measure),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [measure]);
  const paddingBottom = keyboardTop == null ? 0 : Math.max(0, frame.y + frame.height - keyboardTop);
  return <View ref={root} style={{ flex: 1 }} onLayout={measure} collapsable={false}>
    <View style={{ flex: 1, paddingBottom }}>{children}</View>
  </View>;
}

/** 画面・モーダルの高さ調整後の実測viewportを基準にする。二重スクロールを避ける。 */
export const InputScrollView = forwardRef<ScrollView, ScrollViewProps>(function InputScrollView(
  { onLayout, onContentSizeChange, onScroll, ...props }, forwardedRef,
) {
  const scroll = useRef<ScrollView | null>(null);
  const input = useRef<TextInput | null>(null);
  const offset = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const measureAndReveal = useCallback(() => {
    const target = input.current;
    if (!target?.isFocused()) return;
    scroll.current?.getNativeScrollRef()?.measureInWindow((_x, top, _width, height) => {
      if (!target.isFocused() || height <= 0) return;
      target.measureInWindow((_ix, inputTop, _iw, inputHeight) => {
        if (!target.isFocused() || inputHeight <= 0) return;
        const keyboardTop = Keyboard.metrics()?.screenY ?? Infinity;
        const delta = inputScrollDelta(top, height, keyboardTop, inputTop, inputHeight);
        if (Math.abs(delta) < 1) return;
        const next = Math.max(0, offset.current + delta);
        offset.current = next;
        scroll.current?.scrollTo({ y: next, animated: false });
      });
    });
  }, []);
  const reveal = useCallback((target?: TextInput | null) => {
    if (target) input.current = target;
    timers.current.forEach(clearTimeout);
    // IME表示、KAVの再配置、FlatListの行高さ更新をそれぞれ実測する。
    timers.current = [0, 100, 300, 600].map((delay) => setTimeout(measureAndReveal, delay));
  }, [measureAndReveal]);
  useEffect(() => {
    const subscriptions = (['keyboardDidShow', 'keyboardDidHide', 'keyboardWillChangeFrame', 'keyboardDidChangeFrame'] as const)
      .map((event) => Keyboard.addListener(event, () => reveal()));
    return () => { subscriptions.forEach((subscription) => subscription.remove()); timers.current.forEach(clearTimeout); };
  }, [reveal]);
  const setRef = useCallback((value: ScrollView | null) => {
    scroll.current = value;
    assignRef(forwardedRef, value);
  }, [forwardedRef]);
  return <InputViewport.Provider value={reveal}>
    <ScrollView {...props} ref={setRef} keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'}
      scrollEventThrottle={16}
      onScroll={(event) => { offset.current = event.nativeEvent.contentOffset.y; onScroll?.(event); }}
      onLayout={(event) => { onLayout?.(event); reveal(); }}
      onContentSizeChange={(width, height) => { onContentSizeChange?.(width, height); reveal(); }} />
  </InputViewport.Provider>;
});

/** 最も近いスクロール領域だけにフォーカスを通知し、別モーダルや検索欄を動かさない。 */
export const InputTextInput = forwardRef<TextInput, TextInputProps>(function InputTextInput(props, forwardedRef) {
  const native = useRef<TextInput | null>(null);
  const reveal = useContext(InputViewport);
  const setRef = useCallback((value: TextInput | null) => { native.current = value; assignRef(forwardedRef, value); }, [forwardedRef]);
  const ensureVisible = () => { if (native.current?.isFocused()) reveal?.(native.current); };
  return <TextInput {...props} ref={setRef}
    onFocus={(event) => { reveal?.(native.current); props.onFocus?.(event); }}
    onLayout={(event) => { props.onLayout?.(event); ensureVisible(); }}
    onChangeText={(text) => { props.onChangeText?.(text); ensureVisible(); }}
    onSelectionChange={(event) => { props.onSelectionChange?.(event); ensureVisible(); }}
    onContentSizeChange={(event) => { props.onContentSizeChange?.(event); ensureVisible(); }} />;
});

export function renderInputScrollView(props: ScrollViewProps) {
  return <InputScrollView {...props} />;
}

/** Modalは別のnative windowなので、その内部にもキーボード回避領域が必要。 */
export function InputModal({ children, ...props }: ModalProps) {
  return <Modal {...props}>
    <KeyboardViewport>
      {children}
    </KeyboardViewport>
  </Modal>;
}
