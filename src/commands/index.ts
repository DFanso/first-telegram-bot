import { Command } from '../types';
import { startCommand } from './start';
import { videosCommand } from './videos';
import { helpCommand } from './help';
import { infoCommand } from './info';

export const commands: Command[] = [
  startCommand,
  helpCommand,
  videosCommand,
  infoCommand
  // Add more commands here
]; 