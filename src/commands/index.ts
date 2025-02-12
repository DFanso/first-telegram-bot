import { Command } from '../types';
import { startCommand } from './start';
import { videosCommand } from './videos';
import { helpCommand } from './help';
import { infoCommand } from './info';
import { downloadCommand } from './download';

export const commands: Command[] = [
  startCommand,
  helpCommand,
  videosCommand,
  infoCommand,
  downloadCommand
  // Add more commands here
]; 