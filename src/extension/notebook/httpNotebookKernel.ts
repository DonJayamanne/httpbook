import * as vscode from 'vscode';
import * as Httpyac from 'httpyac';
import * as extensionApi from '../extensionApi';
import * as httpOutput from '../httpOutputProvider';
import { AppConfig, TestSlotOutput } from '../config';
import { TestResult } from 'httpyac';


export class HttpNotebookKernel {

  private executionOrder = 0;

  readonly httpOutputProvider: Array<extensionApi.HttpOutputProvider>;

  constructor(
    private readonly httpyac: typeof Httpyac,
    private readonly httpFileStore: Httpyac.HttpFileStore,
    readonly config: AppConfig,
  ) {
    this.controller = vscode.notebook.createNotebookController('httpbook-kernel', 'http', 'HttpBook');
    this.controller.supportedLanguages = ['http'];
    this.controller.hasExecutionOrder = true;
    this.controller.description = 'a Notebook for sending REST, SOAP, and GraphQL requests';
    this.controller.executeHandler = this.send.bind(this);
    this.controller.onDidReceiveMessage(this.onDidReceiveMessage, this);

    this.httpOutputProvider = [
      new httpOutput.TestResultsMimeOutpoutProvider(),
      new httpOutput.Rfc7230HttpOutpoutProvider(config, this.httpyac),
      new httpOutput.BuiltInHttpOutputProvider(),
      new httpOutput.ImageHttpOutputProvider(),
      new httpOutput.ContentTypeHttpOutputProvider(config),
      new httpOutput.MarkdownHttpOutputProvider(config, this.httpyac),
    ];
  }


  private readonly controller: vscode.NotebookController;


  dispose(): void {
    this.controller.dispose();
  }

  private onDidReceiveMessage(event: { editor: vscode.NotebookEditor, message: unknown }) {
    for (const httpOutputProvider of this.httpOutputProvider) {
      if (httpOutputProvider.onDidReceiveMessage) {
        httpOutputProvider.onDidReceiveMessage(event);
      }
    }
  }

  private async send(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument, controller: vscode.NotebookController): Promise<void> {
    const httpFile = this.httpFileStore.get(notebook.uri);
    if (httpFile) {

      for (const cell of cells) {
        const currentFile = await this.httpFileStore.parse(notebook.uri, cell.document.getText());
        if (currentFile.httpRegions.length > 0) {
          const httpRegion = currentFile.httpRegions[0];
          const execution = controller.createNotebookCellExecutionTask(cell);
          execution.executionOrder = ++this.executionOrder;
          try {
            execution.start({ startTime: Date.now() });
            await this.httpyac.httpYacApi.send({
              httpFile,
              httpRegion,
            });
            const outputs: Array<vscode.NotebookCellOutput> = [];

            const httpOutputContext: extensionApi.HttpOutputContext = {
              cell,
              httpRegion,
              mimeType: httpRegion.response?.contentType?.mimeType,
              httpFile
            };

            if (httpRegion.testResults && this.canShowTestResults(httpRegion.testResults)) {
              const testResults = httpRegion.testResults;
              const outputItems = this.mapHttpOutputProvider(
                obj => !!obj.getTestResultOutputResult && obj.getTestResultOutputResult(testResults, httpOutputContext)
              );
              if (outputItems.length > 0) {
                outputs.push(this.createNotebookCellOutput(outputItems, httpRegion.response?.contentType?.mimeType));
              }
            }
            if (httpRegion.response) {
              const response = httpRegion.response;
              const outputItems = this.mapHttpOutputProvider(
                obj => !!obj.getResponseOutputResult && obj.getResponseOutputResult(response, httpOutputContext)
              );
              if (outputItems.length > 0) {
                outputs.push(this.createNotebookCellOutput(outputItems, response.contentType?.mimeType));
              }
            }
            execution.replaceOutput(outputs);
            execution.end({
              success: true,
              endTime: Date.now(),
            });
          } catch (err) {
            execution.replaceOutput([
              new vscode.NotebookCellOutput([
                new vscode.NotebookCellOutputItem('application/x.notebook.error-traceback', {
                  ename: err instanceof Error && err.name || 'error',
                  evalue: err instanceof Error && err.message || JSON.stringify(err, null, 2),
                  traceback: [err.stack]
                })
              ])]);
            execution.end({ success: false, endTime: Date.now() });
          }
        }
      }
    }
  }

  private canShowTestResults(testResults: Array<TestResult> | undefined) {
    if (testResults && this.config.outputTests !== TestSlotOutput.never) {
      if (this.config.outputTests === TestSlotOutput.onlyFailed) {
        return testResults.some(obj => !obj.result);
      }
      return true;
    }
    return false;
  }

  private mapHttpOutputProvider(mapFunc: (obj: extensionApi.HttpOutputProvider) => (extensionApi.HttpOutputResult | false)) {
    const result: Array<extensionApi.HttpOutputResult> = [];

    for (const httpOutputProvider of this.httpOutputProvider) {
      const obj = mapFunc(httpOutputProvider);
      if (obj) {
        result.push(obj);
      }
    }
    return result;
  }

  private createNotebookCellOutput(outputItems: Array<extensionApi.HttpOutputResult>, mimeType?: string) {
    const preferredMime = this.getPreferredNotebookOutputRendererMime(mimeType);

    const items = outputItems
      .sort((obj1, obj2) => this.compareHttpOutputResults(obj1, obj2, preferredMime))
      .reduce((prev: Array<vscode.NotebookCellOutputItem>, current) => {
        if (Array.isArray(current.outputItems)) {
          prev.push(...current.outputItems);
        } else {
          prev.push(current.outputItems);
        }
        return prev;
      }, [])
      .filter((obj, index, self) => self.indexOf(obj) === index);

    return new vscode.NotebookCellOutput(items);
  }

  private getPreferredNotebookOutputRendererMime(mimeType?: string) {
    if (mimeType && this.config.preferNotebookOutputRenderer) {
      for (const [regex, mime] of Object.entries(this.config.preferNotebookOutputRenderer)) {
        const regexp = new RegExp(regex, 'ui');
        if (regexp.test(mimeType)) {
          return mime;
        }
      }
    }
    return '';
  }

  private compareHttpOutputResults(obj1: extensionApi.HttpOutputResult, obj2: extensionApi.HttpOutputResult, mime?: string) {

    if (mime) {
      if (this.hasHttpOutputResultsMime(obj1, mime)) {
        return -1;
      }
      if (this.hasHttpOutputResultsMime(obj2, mime)) {
        return 1;
      }
    }
    return obj2.priority - obj1.priority;
  }

  private hasHttpOutputResultsMime(obj: extensionApi.HttpOutputResult, mime?: string) : boolean {
    if (Array.isArray(obj.outputItems)) {
      return obj.outputItems.some(obj => obj.mime === mime);
    }
    return obj.outputItems.mime === mime;
  }
}
