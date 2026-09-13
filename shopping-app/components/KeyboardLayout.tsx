import { forwardRef } from 'react';
import { Modal, Platform, ScrollView, type ModalProps, type ScrollViewProps } from 'react-native';
import { KeyboardAwareScrollView, KeyboardAvoidingView } from 'react-native-keyboard-controller';

/** 一覧・フォームで共用する。フォーカス切替、数字IME、複数行のカーソル移動にも追従する。 */
export const InputScrollView = forwardRef<ScrollView, ScrollViewProps>(function InputScrollView(props, ref) {
  return <KeyboardAwareScrollView ref={ref} bottomOffset={16} keyboardShouldPersistTaps="handled" {...props} />;
});

// FlatListの仮想化・ref・スクロールイベントを保持したまま入力追従を加える。
export function renderInputScrollView(props: ScrollViewProps) {
  return <InputScrollView {...props} />;
}

/** Modalは別のnative windowなので、その内部にもキーボード回避領域が必要。 */
export function InputModal({ children, ...props }: ModalProps) {
  return <Modal {...props}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {children}
    </KeyboardAvoidingView>
  </Modal>;
}
