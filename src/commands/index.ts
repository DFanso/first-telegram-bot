import { Command } from '../types';
import { startCommand } from './start';
import { videosCommand } from './videos';
import { helpCommand } from './help';

export const commands: Command[] = [
  startCommand,
  helpCommand,
  videosCommand
  // Add more commands here
]; 