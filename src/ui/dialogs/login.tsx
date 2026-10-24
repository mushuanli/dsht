/** A dedicated credential field, separate from the conversation draft and its recall. */
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '../input/input.tsx';

export function LoginDialog({ base, width, onLogin }: {
  base: string; width: number; onLogin(url: string): void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  return <Box borderStyle="round" paddingX={1} flexDirection="column">
    <Text bold>Login required · {base}</Text>
    <Text>Paste the complete URL printed by dsh web (including ?token=…).</Text>
    <Text dimColor>Whitespace is removed automatically · Enter to log in · Ctrl+C to exit</Text>
    {error && <Text color="red">{error}</Text>}
    <TextInput value={url} onChange={value => { setUrl(value.replace(/\s/gu, '')); setError(''); }}
      onCursorChange={() => {}} onSubmit={() => {
        try { onLogin(url); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid login URL'); }
      }} focus placeholder={`${base}${base.includes('?') ? '&' : '?'}token=…`}
      width={Math.max(1, width - 6)} maxRows={3} />
  </Box>;
}
